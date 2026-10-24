import { diffTrees, type DiffNode } from "./diff/treeDiff.js";
import { findContiguous, isSimpleReturn, rewriteNames, type IrNode } from "./parse/ir.js";
import {
  moduleMatchesFile,
  parseFile,
  type CallSite,
  type ImportSite,
  type Param,
  type ParsedFile,
  type Signature,
  type Symbol,
} from "./parse/extract.js";
import { earlierSpan, sourceSlice, spanContains, type Span } from "./span.js";
import { summarize } from "./summary.js";
import type {
  AnalyzeOptions,
  AstEdit,
  FileEntry,
  Highlight,
  Operation,
  OrderedSymbol,
  ParamChange,
  Report,
  Snapshot,
  SymbolRef,
} from "./types.js";

interface Match {
  left: Symbol;
  right: Symbol;
  via: "anchor" | "hash" | "similar";
}

interface Explanation {
  left: Span[];
  right: Span[];
}

const KIND_ORDER = ["rename", "rename-move", "move", "extract", "inline", "signature-change", "reorder", "logic-edit", "add", "remove"];

export function analyzeSnapshots(left: Snapshot, right: Snapshot, options: AnalyzeOptions = {}): Report {
  const leftParsed = parseSnapshot(left);
  const rightParsed = parseSnapshot(right);
  const formatting = new Set(formattingFiles(leftParsed, rightParsed));
  const leftSymbols = leftParsed.flatMap((file) => file.symbols);
  const rightSymbols = rightParsed.flatMap((file) => file.symbols);
  const matches = matchSymbols(leftSymbols, rightSymbols);
  const matchedLeft = new Set(matches.map((match) => match.left.id));
  const matchedRight = new Set(matches.map((match) => match.right.id));
  const functionRenames = new Map<string, string>();
  const methodRenames = new Map<string, string>();
  for (const match of matches) {
    if (match.left.name === match.right.name) continue;
    if (match.left.kind === "method") methodRenames.set(match.left.name, match.right.name);
    else functionRenames.set(match.left.name, match.right.name);
  }

  const operations: Operation[] = [];
  const explained = new Map<string, Explanation>();
  const consumedLeft = new Set<string>();
  const consumedRight = new Set<string>();

  for (const match of matches) {
    const nameChanged = match.left.name !== match.right.name;
    const fileChanged = match.left.file !== match.right.file;
    if (nameChanged && fileChanged) {
      operations.push({
        kind: "rename-move",
        symbolKind: match.left.kind,
        from: refOf(match.left),
        to: refOf(match.right),
        callSitesUpdated: updatedCalls(leftParsed, rightParsed, match.left, match.right),
        importsUpdated: updatedMoveImports(leftParsed, rightParsed, match.left.file, match.right.file, match.left.name, match.right.name),
        confidence: match.via === "similar" ? 0.8 : 0.96,
      });
    } else if (nameChanged) {
      operations.push({
        kind: "rename",
        symbolKind: match.left.kind,
        from: refOf(match.left),
        to: refOf(match.right),
        callSitesUpdated: updatedCalls(leftParsed, rightParsed, match.left, match.right),
        importsUpdated: updatedRenameImports(leftParsed, rightParsed, match.left.name, match.right.name),
        confidence: match.via === "similar" ? 0.84 : 0.98,
      });
    } else if (fileChanged) {
      operations.push({
        kind: "move",
        symbolKind: match.left.kind,
        from: refOf(match.left),
        to: refOf(match.right),
        importsUpdated: updatedMoveImports(leftParsed, rightParsed, match.left.file, match.right.file, match.left.name, match.right.name),
        confidence: match.via === "similar" ? 0.82 : 0.97,
      });
    }
    const signature = diffSignature(match.left.signature, match.right.signature);
    if (signature) {
      operations.push({
        kind: "signature-change",
        symbolKind: match.left.kind,
        name: match.right.name,
        qualifiedName: match.right.qualifiedName,
        from: refOf(match.left),
        to: refOf(match.right),
        addedParams: signature.addedParams,
        removedParams: signature.removedParams,
        changedParams: signature.changedParams,
        ...(signature.parameterOrder ? { parameterOrder: signature.parameterOrder } : {}),
        ...(signature.returnType ? { returnType: signature.returnType } : {}),
        ...(signature.async ? { async: signature.async } : {}),
        ...(signature.bases ? { bases: signature.bases } : {}),
        ...(signature.decorators ? { decorators: signature.decorators } : {}),
        confidence: 0.95,
      });
    }
  }

  for (const extracted of rightSymbols) {
    if (matchedRight.has(extracted.id) || extracted.kind === "class") continue;
    let best: { host: Match; start: number; length: number; score: number } | null = null;
    for (const host of matches) {
      if (host.left.kind === "class" || host.right.kind === "class") continue;
      if (!host.right.calls.includes(extracted.name)) continue;
      const located = locateNeedle(host.left.skeletons, extracted);
      if (!located) continue;
      const slice = host.left.skeletons.slice(located.start, located.start + located.length);
      const stillThere = slice.filter((statement) => host.right.skeletons.includes(statement)).length;
      if (stillThere / located.length > 0.34) continue;
      if (located.length === host.left.skeletons.length && host.right.skeletons.length >= located.length) continue;
      const score = located.length * 10 + (host.right.file === extracted.file ? 4 : 0);
      if (!best || score > best.score) best = { host, start: located.start, length: located.length, score };
    }
    if (!best) continue;
    consumedRight.add(extracted.id);
    operations.push({
      kind: "extract",
      source: refOf(best.host.left),
      host: refOf(best.host.right),
      extracted: refOf(extracted),
      confidence: 0.91,
    });
    remember(explained, best.host.left.id, "left", best.host.left.stmtSpans.slice(best.start, best.start + best.length));
    const remaining = new Set([
      ...best.host.left.skeletons.slice(0, best.start),
      ...best.host.left.skeletons.slice(best.start + best.length),
    ]);
    const extra = best.host.right.stmtSpans.filter((_, index) => {
      const skeleton = best.host.right.skeletons[index];
      return skeleton !== undefined && !remaining.has(skeleton);
    });
    remember(explained, best.host.left.id, "right", extra);
  }

  for (const source of leftSymbols) {
    if (matchedLeft.has(source.id) || consumedLeft.has(source.id) || source.kind === "class") continue;
    let best: { host: Match; start: number; length: number; score: number } | null = null;
    for (const host of matches) {
      if (host.left.kind === "class" || host.right.kind === "class") continue;
      if (!host.left.calls.includes(source.name)) continue;
      if (host.right.calls.includes(source.name)) continue;
      const located = locateNeedle(host.right.skeletons, source);
      if (!located) continue;
      const score = located.length * 10 + (host.right.file === source.file ? 3 : 0);
      if (!best || score > best.score) best = { host, start: located.start, length: located.length, score };
    }
    if (!best) continue;
    consumedLeft.add(source.id);
    operations.push({
      kind: "inline",
      source: refOf(source),
      hostBefore: refOf(best.host.left),
      hostAfter: refOf(best.host.right),
      confidence: 0.9,
    });
    const callSpans = best.host.left.stmtSpans.filter((_, index) => mentionsIdentifier(best.host.left.skeletons[index] ?? "", source.name));
    remember(explained, best.host.left.id, "left", callSpans);
    remember(explained, best.host.left.id, "right", best.host.right.stmtSpans.slice(best.start, best.start + best.length));
  }

  operations.push(...reorderOperations(leftSymbols, matches));

  const leftText = new Map(leftParsed.map((file) => [file.path, file.text]));
  const rightText = new Map(rightParsed.map((file) => [file.path, file.text]));
  for (const match of matches) {
    if (match.left.kind === "class" && match.left.fieldKey === match.right.fieldKey) continue;
    const edits = logicEdits(match, functionRenames, methodRenames, explained.get(match.left.id), leftText, rightText);
    if (edits.length === 0) continue;
    operations.push({
      kind: "logic-edit",
      symbol: refOf(match.right),
      before: refOf(match.left),
      edits,
      confidence: match.via === "anchor" ? 0.9 : 0.8,
    });
  }

  for (const symbol of leftSymbols) {
    if (matchedLeft.has(symbol.id) || consumedLeft.has(symbol.id)) continue;
    if (formatting.has(symbol.file)) continue;
    operations.push({ kind: "remove", symbol: refOf(symbol), confidence: 0.7 });
  }
  for (const symbol of rightSymbols) {
    if (matchedRight.has(symbol.id) || consumedRight.has(symbol.id)) continue;
    if (formatting.has(symbol.file)) continue;
    operations.push({ kind: "add", symbol: refOf(symbol), confidence: 0.7 });
  }

  operations.sort((a, b) => {
    const kind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    if (kind !== 0) return kind;
    const file = operationFile(a).localeCompare(operationFile(b));
    if (file !== 0) return file;
    return operationLine(a) - operationLine(b);
  });

  const ignoredFormatting = [...formatting].sort().map((file) => ({ file, reason: "normalized AST identical" }));
  const prose = summarize(operations, ignoredFormatting.map((entry) => entry.file));
  const files = fileEntries(leftParsed, rightParsed, formatting);
  const byKind: Record<string, number> = {};
  for (const operation of operations) byKind[operation.kind] = (byKind[operation.kind] ?? 0) + 1;
  const embed = options.embedSources !== false;
  const report: Report = {
    tool: "semantic-diff",
    version: 1,
    left: { label: options.leftLabel ?? left.label },
    right: { label: options.rightLabel ?? right.label },
    summary: prose.summary,
    summaryLines: prose.summaryLines,
    stats: {
      operations: operations.length,
      byKind,
      formattingOnlyFiles: ignoredFormatting.length,
      filesCompared: files.length,
      filesChanged: files.filter((file) => file.status !== "unchanged").length,
    },
    operations,
    ignoredFormatting,
    files,
    parseDiagnostics: [
      ...leftParsed.flatMap((file) => file.diagnostics.map((message) => ({ file: file.path, side: "left" as const, message }))),
      ...rightParsed.flatMap((file) => file.diagnostics.map((message) => ({ file: file.path, side: "right" as const, message }))),
    ],
    highlights: highlightsFor(operations),
  };
  if (embed) {
    report.sources = {
      left: Object.fromEntries(leftParsed.filter((file) => !unchanged(file, rightParsed)).map((file) => [file.path, file.text])),
      right: Object.fromEntries(rightParsed.filter((file) => !unchanged(file, leftParsed)).map((file) => [file.path, file.text])),
    };
  }
  if (options.debug) {
    const project = (side: "left" | "right", symbols: Symbol[]) =>
      symbols.map((symbol) => ({
        side,
        file: symbol.file,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        kind: symbol.kind,
        calls: symbol.calls,
        skeletons: symbol.skeletons,
        bodyHash: symbol.bodyHash,
      }));
    report.debug = { symbols: [...project("left", leftSymbols), ...project("right", rightSymbols)] };
  }
  return report;
}

function parseSnapshot(snapshot: Snapshot): ParsedFile[] {
  const parsed: ParsedFile[] = [];
  for (const file of [...snapshot.files].sort((a, b) => a.path.localeCompare(b.path))) {
    const result = parseFile(file.path, file.text.replace(/\r\n/g, "\n"));
    if (result) parsed.push(result);
  }
  return parsed;
}

function formattingFiles(left: ParsedFile[], right: ParsedFile[]): string[] {
  const rightByPath = new Map(right.map((file) => [file.path, file]));
  const ignored: string[] = [];
  for (const file of left) {
    const other = rightByPath.get(file.path);
    if (!other) continue;
    if (file.text === other.text) continue;
    if (file.treeKey && file.treeKey === other.treeKey) ignored.push(file.path);
  }
  return ignored;
}

function fileEntries(left: ParsedFile[], right: ParsedFile[], formatting: Set<string>): FileEntry[] {
  const rightByPath = new Map(right.map((file) => [file.path, file]));
  const leftByPath = new Map(left.map((file) => [file.path, file]));
  const paths = [...new Set([...leftByPath.keys(), ...rightByPath.keys()])].sort();
  return paths.map((path) => {
    const before = leftByPath.get(path);
    const after = rightByPath.get(path);
    const language = (after ?? before)?.language;
    let status: FileEntry["status"];
    if (!before) status = "added";
    else if (!after) status = "deleted";
    else if (before.text === after.text) status = "unchanged";
    else if (formatting.has(path)) status = "formatting-only";
    else status = "modified";
    return language ? { path, status, language } : { path, status };
  });
}

function unchanged(file: ParsedFile, other: ParsedFile[]): boolean {
  const match = other.find((candidate) => candidate.path === file.path);
  return Boolean(match && match.text === file.text);
}

function matchSymbols(left: Symbol[], right: Symbol[]): Match[] {
  const matches: Match[] = [];
  const usedLeft = new Set<string>();
  const usedRight = new Set<string>();
  const rightByAnchor = new Map<string, Symbol>();
  for (const symbol of right) rightByAnchor.set(anchorKey(symbol), symbol);

  for (const symbol of left) {
    const candidate = rightByAnchor.get(anchorKey(symbol));
    if (!candidate || usedRight.has(candidate.id)) continue;
    const clonedBody = right.some((other) => other.id !== candidate.id && other.bodyHash === symbol.bodyHash && other.kind === symbol.kind);
    if (clonedBody && symbol.bodyHash !== candidate.bodyHash) continue;
    matches.push({ left: symbol, right: candidate, via: "anchor" });
    usedLeft.add(symbol.id);
    usedRight.add(candidate.id);
  }

  const pairs: Array<{ left: Symbol; right: Symbol; score: number; via: Match["via"] }> = [];
  for (const symbol of left) {
    if (usedLeft.has(symbol.id)) continue;
    for (const candidate of right) {
      if (usedRight.has(candidate.id) || symbol.kind !== candidate.kind) continue;
      if (symbol.bodyHash === candidate.bodyHash) pairs.push({ left: symbol, right: candidate, score: 100 + pairScore(symbol, candidate), via: "hash" });
      else {
        const similarity = bodySimilarity(symbol, candidate);
        if (similarity >= 0.86) pairs.push({ left: symbol, right: candidate, score: similarity * 50 + pairScore(symbol, candidate), via: "similar" });
      }
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.left.id.localeCompare(b.left.id) || a.right.id.localeCompare(b.right.id));
  for (const pair of pairs) {
    if (usedLeft.has(pair.left.id) || usedRight.has(pair.right.id)) continue;
    matches.push({ left: pair.left, right: pair.right, via: pair.via });
    usedLeft.add(pair.left.id);
    usedRight.add(pair.right.id);
  }
  return matches;
}

function anchorKey(symbol: Symbol): string {
  return `${symbol.file}::${symbol.kind}::${symbol.qualifiedName}`;
}

function pairScore(left: Symbol, right: Symbol): number {
  let score = 0;
  if (left.name === right.name) score += 4;
  if (left.file === right.file) score += 2;
  if (left.qualifiedName === right.qualifiedName) score += 1;
  return score;
}

function bodySimilarity(left: Symbol, right: Symbol): number {
  if (left.bodyHash === right.bodyHash) return 1;
  return jaccard(left.skeletons, right.skeletons);
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 1;
  const leftCounts = new Map<string, number>();
  const rightCounts = new Map<string, number>();
  for (const value of left) leftCounts.set(value, (leftCounts.get(value) ?? 0) + 1);
  for (const value of right) rightCounts.set(value, (rightCounts.get(value) ?? 0) + 1);
  let intersection = 0;
  let union = 0;
  for (const key of new Set([...leftCounts.keys(), ...rightCounts.keys()])) {
    const a = leftCounts.get(key) ?? 0;
    const b = rightCounts.get(key) ?? 0;
    intersection += Math.min(a, b);
    union += Math.max(a, b);
  }
  return union === 0 ? 1 : intersection / union;
}

function locateNeedle(host: readonly string[], symbol: Symbol): { start: number; length: number } | null {
  const full = findContiguous(host, symbol.skeletons);
  if (symbol.skeletons.length >= 2 && full >= 0) return { start: full, length: symbol.skeletons.length };
  const statements = symbol.statements;
  if (statements.length >= 3 && isSimpleReturn(statements[statements.length - 1]!)) {
    const core = symbol.skeletons.slice(0, -1);
    const start = findContiguous(host, core);
    if (core.length >= 2 && start >= 0) return { start, length: core.length };
  }
  return null;
}

function reorderOperations(symbols: Symbol[], matches: Match[]): Operation[] {
  const byLeft = new Map(matches.map((match) => [match.left.id, match]));
  const groups = new Map<string, Symbol[]>();
  for (const symbol of symbols) {
    const key = symbol.kind === "method" ? `${symbol.file}::class::${symbol.parent ?? ""}` : `${symbol.file}::file`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(symbol);
    else groups.set(key, [symbol]);
  }
  const operations: Operation[] = [];
  for (const [key, group] of groups) {
    const stayed = group.filter((symbol) => {
      const match = byLeft.get(symbol.id);
      return Boolean(match && match.right.file === symbol.file && (symbol.parent ?? "") === (match.right.parent ?? ""));
    });
    if (stayed.length < 2) continue;
    const ordered = [...stayed].sort((a, b) => earlierSpan(byLeft.get(a.id)!.right.span, byLeft.get(b.id)!.right.span));
    if (stayed.every((symbol, index) => symbol.id === ordered[index]?.id)) continue;
    const scope = key.includes("::class::") ? "class" : "file";
    operations.push({
      kind: "reorder",
      scope,
      file: stayed[0]!.file,
      ...(scope === "class" && stayed[0]?.parent ? { container: stayed[0].parent } : {}),
      before: stayed.map((symbol) => orderedSymbol(symbol)),
      after: ordered.map((symbol) => orderedSymbol(byLeft.get(symbol.id)!.right)),
      confidence: 0.93,
    });
  }
  return operations;
}

function logicEdits(
  match: Match,
  functionRenames: ReadonlyMap<string, string>,
  methodRenames: ReadonlyMap<string, string>,
  explanation: Explanation | undefined,
  leftText: Map<string, string>,
  rightText: Map<string, string>,
): AstEdit[] {
  const rewritten = rewriteNames(match.left.body, new Set(match.left.bound), functionRenames, methodRenames);
  let edits = diffTrees(asDiff(rewritten), asDiff(match.right.body));
  if (explanation) edits = edits.filter((edit) => !explainedEdit(edit, explanation));
  const beforeSource = leftText.get(match.left.file) ?? "";
  const afterSource = rightText.get(match.right.file) ?? "";
  return edits.map((edit) => ({
    op: edit.op,
    nodeType: edit.nodeType,
    ...(edit.before ? { before: { span: edit.before.span, text: sourceSlice(beforeSource, edit.before.span) || edit.before.text } } : {}),
    ...(edit.after ? { after: { span: edit.after.span, text: sourceSlice(afterSource, edit.after.span) || edit.after.text } } : {}),
  }));
}

function asDiff(node: IrNode): DiffNode {
  return { type: node.type, text: node.text, span: node.span, children: node.children.map(asDiff) };
}

function explainedEdit(edit: AstEdit, explanation: Explanation): boolean {
  const onLeft = edit.before ? explanation.left.some((span) => spanContains(span, edit.before!.span)) : false;
  const onRight = edit.after ? explanation.right.some((span) => spanContains(span, edit.after!.span)) : false;
  if (edit.op === "delete") return onLeft;
  if (edit.op === "insert") return onRight;
  return onLeft && onRight;
}

function remember(target: Map<string, Explanation>, id: string, side: "left" | "right", spans: Span[]): void {
  const current = target.get(id) ?? { left: [], right: [] };
  current[side].push(...spans);
  target.set(id, current);
}

function mentionsIdentifier(skeleton: string, name: string): boolean {
  for (const type of ["identifier", "property_identifier"]) {
    const token = `${type}:${name}`;
    if (
      skeleton.includes(`${token},`) ||
      skeleton.includes(`${token})`) ||
      skeleton.endsWith(token)
    ) {
      return true;
    }
  }
  return false;
}

interface SignatureDiff {
  addedParams: string[];
  removedParams: string[];
  changedParams: ParamChange[];
  parameterOrder?: { from: string[]; to: string[] };
  returnType?: { from?: string; to?: string };
  async?: { from: boolean; to: boolean };
  bases?: { from: string[]; to: string[] };
  decorators?: { from: string[]; to: string[] };
}

function diffSignature(left: Signature, right: Signature): SignatureDiff | null {
  const addedParams: string[] = [];
  const removedParams: string[] = [];
  const changedParams: ParamChange[] = [];
  const used = new Set<number>();
  for (const param of left.params) {
    const index = right.params.findIndex((candidate, candidateIndex) => !used.has(candidateIndex) && candidate.name === param.name);
    if (index < 0) {
      removedParams.push(param.name);
      continue;
    }
    used.add(index);
    const other = right.params[index];
    if (other && describeParam(param) !== describeParam(other)) {
      changedParams.push({ name: param.name, from: describeParam(param), to: describeParam(other) });
    }
  }
  right.params.forEach((param, index) => {
    if (!used.has(index)) addedParams.push(param.name);
  });
  const leftOrder = left.params.map((param) => param.name);
  const rightOrder = right.params.map((param) => param.name);
  const orderChanged =
    leftOrder.length === rightOrder.length &&
    leftOrder.join("\0") !== rightOrder.join("\0") &&
    [...leftOrder].sort().join("\0") === [...rightOrder].sort().join("\0");
  const returnChanged = (left.returnType ?? "") !== (right.returnType ?? "");
  const asyncChanged = left.async !== right.async;
  const basesChanged = left.bases.join("\0") !== right.bases.join("\0");
  const decoratorsChanged = left.decorators.join("\0") !== right.decorators.join("\0");
  if (!addedParams.length && !removedParams.length && !changedParams.length && !orderChanged && !returnChanged && !asyncChanged && !basesChanged && !decoratorsChanged) {
    return null;
  }
  const diff: SignatureDiff = { addedParams, removedParams, changedParams };
  if (orderChanged) diff.parameterOrder = { from: leftOrder, to: rightOrder };
  if (returnChanged) diff.returnType = { ...(left.returnType ? { from: left.returnType } : {}), ...(right.returnType ? { to: right.returnType } : {}) };
  if (asyncChanged) diff.async = { from: left.async, to: right.async };
  if (basesChanged) diff.bases = { from: left.bases, to: right.bases };
  if (decoratorsChanged) diff.decorators = { from: left.decorators, to: right.decorators };
  return diff;
}

function describeParam(param: Param): string {
  const rest = param.rest ? "..." : "";
  const optional = param.optional && param.default === undefined ? "?" : "";
  const type = param.type ? `: ${param.type}` : "";
  const fallback = param.default !== undefined ? ` = ${param.default}` : "";
  return `${rest}${param.name}${optional}${type}${fallback}`;
}

function updatedCalls(left: ParsedFile[], right: ParsedFile[], before: Symbol, after: Symbol): number {
  const form: CallSite["form"] = before.kind === "method" ? "method" : "call";
  return Math.min(countCalls(left, before.name, form), countCalls(right, after.name, form));
}

function countCalls(files: ParsedFile[], name: string, form: CallSite["form"]): number {
  let count = 0;
  for (const file of files) {
    for (const call of file.calls) if (call.name === name && call.form === form) count++;
  }
  return count;
}

function updatedRenameImports(left: ParsedFile[], right: ParsedFile[], oldName: string, newName: string): number {
  const before = new Map(left.map((file) => [file.path, file]));
  let count = 0;
  for (const file of right) {
    const previous = before.get(file.path);
    if (!previous) continue;
    const oldCount = previous.imports.filter((entry) => entry.imported === oldName || entry.local === oldName).length;
    const newCount = file.imports.filter((entry) => entry.imported === newName || entry.local === newName).length;
    if (oldCount && newCount) count += Math.min(oldCount, newCount);
  }
  return count;
}

function updatedMoveImports(
  left: ParsedFile[],
  right: ParsedFile[],
  fromFile: string,
  toFile: string,
  oldName: string,
  newName: string,
): number {
  const before = new Map(left.map((file) => [file.path, file]));
  let count = 0;
  for (const file of right) {
    const previous = before.get(file.path);
    if (!previous) continue;
    const had = previous.imports.some((entry) => namesMatch(entry, oldName) && moduleMatchesFile(entry.resolved, fromFile));
    const has = file.imports.some((entry) => namesMatch(entry, newName) && moduleMatchesFile(entry.resolved, toFile));
    if (had && has) count++;
  }
  return count;
}

function namesMatch(entry: ImportSite, name: string): boolean {
  return entry.imported === name || entry.local === name || entry.imported === "*";
}

function refOf(symbol: Symbol): SymbolRef {
  return {
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    file: symbol.file,
    span: symbol.span,
  };
}

function orderedSymbol(symbol: Symbol): OrderedSymbol {
  return { name: symbol.name, qualifiedName: symbol.qualifiedName, span: symbol.span };
}

function operationFile(operation: Operation): string {
  switch (operation.kind) {
    case "rename":
    case "rename-move":
    case "move":
      return operation.from.file;
    case "extract":
      return operation.extracted.file;
    case "inline":
      return operation.hostAfter.file;
    case "signature-change":
      return operation.to.file;
    case "reorder":
      return operation.file;
    case "logic-edit":
      return operation.symbol.file;
    case "add":
    case "remove":
      return operation.symbol.file;
  }
}

function operationLine(operation: Operation): number {
  switch (operation.kind) {
    case "rename":
    case "rename-move":
    case "move":
      return operation.from.span.start.line;
    case "extract":
      return operation.source.span.start.line;
    case "inline":
      return operation.hostAfter.span.start.line;
    case "signature-change":
      return operation.to.span.start.line;
    case "reorder":
      return operation.before[0]?.span.start.line ?? 0;
    case "logic-edit":
      return operation.symbol.span.start.line;
    case "add":
    case "remove":
      return operation.symbol.span.start.line;
  }
}

function highlightsFor(operations: Operation[]): Highlight[] {
  const highlights: Highlight[] = [];
  operations.forEach((operation, opIndex) => {
    const add = (side: "left" | "right", file: string, span: Span) => {
      highlights.push({ opIndex, side, file, span, kind: operation.kind });
    };
    switch (operation.kind) {
      case "rename":
      case "rename-move":
      case "move":
        add("left", operation.from.file, operation.from.span);
        add("right", operation.to.file, operation.to.span);
        break;
      case "extract":
        add("left", operation.source.file, operation.source.span);
        add("right", operation.host.file, operation.host.span);
        add("right", operation.extracted.file, operation.extracted.span);
        break;
      case "inline":
        add("left", operation.source.file, operation.source.span);
        add("left", operation.hostBefore.file, operation.hostBefore.span);
        add("right", operation.hostAfter.file, operation.hostAfter.span);
        break;
      case "signature-change":
        add("left", operation.from.file, operation.from.span);
        add("right", operation.to.file, operation.to.span);
        break;
      case "reorder":
        for (const symbol of operation.before) add("left", operation.file, symbol.span);
        for (const symbol of operation.after) add("right", operation.file, symbol.span);
        break;
      case "logic-edit":
        for (const edit of operation.edits) {
          if (edit.before) add("left", operation.before.file, edit.before.span);
          if (edit.after) add("right", operation.symbol.file, edit.after.span);
        }
        break;
      case "add":
        add("right", operation.symbol.file, operation.symbol.span);
        break;
      case "remove":
        add("left", operation.symbol.file, operation.symbol.span);
        break;
    }
  });
  return highlights;
}
