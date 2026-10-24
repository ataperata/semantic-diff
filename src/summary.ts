import type { AstEdit, Operation, SymbolRef } from "./types.js";

export function summarize(operations: readonly Operation[], formattingFiles: readonly string[]): { summary: string; summaryLines: string[] } {
  const lines = operations.map(describeOperation);
  if (formattingFiles.length === 1) lines.push(`ignored pure formatting in \`${formattingFiles[0]}\``);
  else if (formattingFiles.length > 1 && formattingFiles.length <= 3) {
    lines.push(`ignored pure formatting in ${formattingFiles.map((file) => `\`${file}\``).join(", ")}`);
  } else if (formattingFiles.length > 3) {
    lines.push(`ignored pure formatting in ${formattingFiles.length} files`);
  }
  if (lines.length === 0) return { summary: "no semantic changes", summaryLines: ["no semantic changes"] };
  if (operations.length === 0) {
    return { summary: `no semantic changes; ${lines[0]}`, summaryLines: ["no semantic changes", lines[0] ?? "ignored pure formatting"] };
  }
  return { summary: lines.join("; "), summaryLines: lines };
}

export function describeOperation(operation: Operation): string {
  switch (operation.kind) {
    case "rename":
      return `renamed \`${display(operation.from)}\` to \`${display(operation.to)}\`${referencePhrase(operation.callSitesUpdated, operation.importsUpdated)}`;
    case "rename-move":
      return `renamed \`${display(operation.from)}\` to \`${display(operation.to)}\` and moved it from \`${operation.from.file}\` to \`${operation.to.file}\`${referencePhrase(operation.callSitesUpdated, operation.importsUpdated)}`;
    case "move": {
      const imports = operation.importsUpdated
        ? ` (${operation.importsUpdated} import${operation.importsUpdated === 1 ? "" : "s"} updated)`
        : "";
      return `moved \`${display(operation.from)}\` from \`${operation.from.file}\` to \`${operation.to.file}\`${imports}`;
    }
    case "extract": {
      const destination = operation.extracted.file === operation.source.file ? "" : ` into \`${operation.extracted.file}\``;
      return `extracted \`${operation.extracted.name}\` from \`${operation.source.name}\`${destination}`;
    }
    case "inline":
      return `inlined \`${operation.source.name}\` into \`${operation.hostAfter.name}\``;
    case "signature-change":
      return `signature of \`${operation.symbolKind === "method" ? operation.qualifiedName : operation.name}\` changed (${signatureDetails(operation)})`;
    case "reorder": {
      const before = operation.before.map((symbol) => `\`${symbol.name}\``).join(", ");
      const after = operation.after.map((symbol) => `\`${symbol.name}\``).join(", ");
      if (operation.scope === "class") return `reordered methods of \`${operation.container}\` in \`${operation.file}\` (${before} → ${after})`;
      return `reordered symbols in \`${operation.file}\` (${before} → ${after})`;
    }
    case "logic-edit":
      return `edited \`${operation.symbol.kind === "method" ? operation.symbol.qualifiedName : operation.symbol.name}\` (${editPhrase(operation.edits)})`;
    case "add":
      return `added \`${display(operation.symbol)}\` in \`${operation.symbol.file}\``;
    case "remove":
      return `removed \`${display(operation.symbol)}\` from \`${operation.symbol.file}\``;
  }
}

export function formatReportText(summaryLines: readonly string[], statsLine: string, operations: readonly Operation[], verbose: boolean): string {
  const blocks = [summaryLines.join("\n")];
  if (verbose) {
    for (const operation of operations) {
      if (operation.kind !== "logic-edit") continue;
      const details = operation.edits.map((edit) => {
        if (edit.op === "update") return `  update \`${edit.before?.text ?? ""}\` → \`${edit.after?.text ?? ""}\``;
        if (edit.op === "insert") return `  insert \`${edit.after?.text ?? ""}\``;
        if (edit.op === "delete") return `  delete \`${edit.before?.text ?? ""}\``;
        return `  move \`${edit.before?.text ?? ""}\``;
      });
      blocks.push([`edited \`${operation.symbol.name}\``, ...details].join("\n"));
    }
  }
  blocks.push(statsLine);
  return blocks.filter(Boolean).join("\n\n") + "\n";
}

function display(symbol: SymbolRef): string {
  return symbol.kind === "method" ? symbol.qualifiedName : symbol.name;
}

function referencePhrase(calls: number, imports: number): string {
  const parts: string[] = [];
  if (calls) parts.push(`${calls} call site${calls === 1 ? "" : "s"}`);
  if (imports) parts.push(`${imports} import${imports === 1 ? "" : "s"}`);
  if (parts.length === 0) return "";
  if (parts.length === 1) return ` (${parts[0]} updated)`;
  return ` (${parts[0]} and ${parts[1]} updated)`;
}

function signatureDetails(operation: Extract<Operation, { kind: "signature-change" }>): string {
  const bits: string[] = [];
  for (const name of operation.addedParams) bits.push(`added param \`${name}\``);
  for (const name of operation.removedParams) bits.push(`removed param \`${name}\``);
  for (const change of operation.changedParams) bits.push(`parameter \`${change.name}\` changed`);
  if (operation.parameterOrder) bits.push("reordered parameters");
  if (operation.returnType) bits.push(`return type \`${operation.returnType.from ?? ""}\` → \`${operation.returnType.to ?? ""}\``);
  if (operation.async) bits.push(operation.async.to ? "became async" : "no longer async");
  if (operation.bases) bits.push(`bases \`${operation.bases.from.join(", ")}\` → \`${operation.bases.to.join(", ")}\``);
  if (operation.decorators) bits.push("decorators changed");
  return bits.join(", ") || "shape changed";
}

function editPhrase(edits: readonly AstEdit[]): string {
  const counts = new Map<string, number>();
  for (const edit of edits) counts.set(edit.op, (counts.get(edit.op) ?? 0) + 1);
  const parts = [...counts.entries()].map(([op, count]) => `${count} ${op}${count === 1 ? "" : "s"}`);
  return parts.join(", ") || "structure changed";
}
