import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzePaths, analyzeSnapshots } from "../src/index.js";
import type { Operation } from "../src/types.js";

interface ExpectedOperation {
  kind: Operation["kind"];
  from?: string;
  to?: string;
  name?: string;
  source?: string;
  extracted?: string;
  into?: string;
  qualifiedFrom?: string;
  qualifiedTo?: string;
  fromFile?: string;
  toFile?: string;
  callSitesUpdated?: number;
  importsUpdated?: number;
  addedParams?: string[];
  removedParams?: string[];
  returnFrom?: string;
  returnTo?: string;
  scope?: string;
  container?: string;
  before?: string[];
  after?: string[];
  exactEdits?: boolean;
  edits?: Array<{ op: string; before?: string; after?: string }>;
}

interface ExpectedFile {
  title?: string;
  description?: string;
  summary?: string;
  exactKinds?: string[];
  operations: ExpectedOperation[];
  formattingIgnored?: string[];
  summaryIncludes?: string[];
}

const fixtureRoot = path.resolve("fixtures");

describe("semantic fixtures", () => {
  for (const language of ["typescript", "python"]) {
    const languageDir = path.join(fixtureRoot, language);
    for (const name of readdirSync(languageDir).sort()) {
      const dir = path.join(languageDir, name);
      if (!statSync(dir).isDirectory()) continue;
      it(`${language}/${name}`, () => {
        const expected = JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf8")) as ExpectedFile;
        const report = analyzePaths(path.join(dir, "before"), path.join(dir, "after"), {
          embedSources: false,
          leftLabel: `${language}/${name}/before`,
          rightLabel: `${language}/${name}/after`,
          debug: true,
        });
        const rendered = [
          report.summary,
          "",
          JSON.stringify(
            report.operations.map((operation) => summarizeOp(operation)),
            null,
            2,
          ),
          "",
          "debug",
          JSON.stringify(report.debug, null, 2),
        ].join("\n");
        if (expected.exactKinds) {
          expect(report.operations.map((operation) => operation.kind), rendered).toEqual(expected.exactKinds);
        }
        for (const wanted of expected.operations) {
          const found = report.operations.find((operation) => operationMatches(operation, wanted));
          expect(found, rendered).toBeTruthy();
        }
        if (expected.summary) expect(report.summary, rendered).toBe(expected.summary);
        for (const snippet of expected.summaryIncludes ?? []) expect(report.summary, rendered).toContain(snippet);
        if (expected.formattingIgnored) {
          expect(report.ignoredFormatting.map((entry) => entry.file).sort(), rendered).toEqual([...expected.formattingIgnored].sort());
        }
        expect(report.summary.length).toBeGreaterThan(0);
        expect(report.tool).toBe("semantic-diff");
      });
    }
  }
});

describe("large files", () => {
  it("parses sources larger than the default tree-sitter buffer", () => {
    const body = (bump: number) =>
      Array.from({ length: 1200 }, (_, i) => `export function f${i}(x: number): number {\n  return x + ${i === 5 ? i + bump : i};\n}\n`).join("\n");
    const before = body(0);
    expect(before.length).toBeGreaterThan(32 * 1024);
    const report = analyzeSnapshots(
      { label: "before", files: [{ path: "big.ts", text: before }] },
      { label: "after", files: [{ path: "big.ts", text: body(1) }] },
      { embedSources: false },
    );
    expect(report.parseDiagnostics).toEqual([]);
    expect(report.operations.map((operation) => operation.kind)).toEqual(["logic-edit"]);
  });
});

describe("directory loading", () => {
  it("follows file symlinks like the ones git difftool -d creates", () => {
    const root = mkdtempSync(path.join(tmpdir(), "semantic-diff-links-"));
    try {
      const work = path.join(root, "work");
      const left = path.join(root, "left");
      const right = path.join(root, "right");
      for (const dir of [work, left, right]) mkdirSync(dir);
      writeFileSync(path.join(left, "m.ts"), "export function foo(a: number) {\n  return a + 1;\n}\n");
      writeFileSync(path.join(work, "m.ts"), "export function bar(a: number) {\n  return a + 1;\n}\n");
      symlinkSync(path.join(work, "m.ts"), path.join(right, "m.ts"));
      const report = analyzePaths(left, right, { embedSources: false });
      expect(report.operations.map((operation) => operation.kind)).toEqual(["rename"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function operationMatches(operation: Operation, expected: ExpectedOperation): boolean {
  if (operation.kind !== expected.kind) return false;
  if (expected.kind === "rename" || expected.kind === "rename-move") {
    if (operation.kind !== "rename" && operation.kind !== "rename-move") return false;
    if (expected.from && operation.from.name !== expected.from) return false;
    if (expected.to && operation.to.name !== expected.to) return false;
    if (expected.qualifiedFrom && operation.from.qualifiedName !== expected.qualifiedFrom) return false;
    if (expected.qualifiedTo && operation.to.qualifiedName !== expected.qualifiedTo) return false;
    if (expected.callSitesUpdated !== undefined && operation.callSitesUpdated !== expected.callSitesUpdated) return false;
    if (expected.importsUpdated !== undefined && operation.importsUpdated !== expected.importsUpdated) return false;
    return true;
  }
  if (expected.kind === "move" && operation.kind === "move") {
    if (expected.name && operation.from.name !== expected.name) return false;
    if (expected.fromFile && operation.from.file !== expected.fromFile) return false;
    if (expected.toFile && operation.to.file !== expected.toFile) return false;
    if (expected.importsUpdated !== undefined && operation.importsUpdated !== expected.importsUpdated) return false;
    return true;
  }
  if (expected.kind === "extract" && operation.kind === "extract") {
    return operation.source.name === expected.source && operation.extracted.name === expected.extracted;
  }
  if (expected.kind === "inline" && operation.kind === "inline") {
    return operation.source.name === expected.source && operation.hostAfter.name === expected.into;
  }
  if (expected.kind === "signature-change" && operation.kind === "signature-change") {
    if (operation.name !== expected.name) return false;
    if (expected.addedParams && !includesAll(operation.addedParams, expected.addedParams)) return false;
    if (expected.removedParams && !includesAll(operation.removedParams, expected.removedParams)) return false;
    if (expected.returnFrom && operation.returnType?.from !== expected.returnFrom) return false;
    if (expected.returnTo && operation.returnType?.to !== expected.returnTo) return false;
    return true;
  }
  if (expected.kind === "reorder" && operation.kind === "reorder") {
    if (expected.scope && operation.scope !== expected.scope) return false;
    if (expected.container && operation.container !== expected.container) return false;
    if (expected.before && !sameNames(operation.before.map((symbol) => symbol.name), expected.before)) return false;
    if (expected.after && !sameNames(operation.after.map((symbol) => symbol.name), expected.after)) return false;
    return true;
  }
  if (expected.kind === "logic-edit" && operation.kind === "logic-edit") {
    if (operation.symbol.name !== expected.name) return false;
    if (expected.edits) {
      for (const edit of expected.edits) {
        const found = operation.edits.some(
          (candidate) =>
            candidate.op === edit.op &&
            (edit.before === undefined || candidate.before?.text === edit.before) &&
            (edit.after === undefined || candidate.after?.text === edit.after),
        );
        if (!found) return false;
      }
      if (expected.exactEdits && operation.edits.length !== expected.edits.length) return false;
    }
    return true;
  }
  return false;
}

function includesAll(actual: string[], expected: string[]): boolean {
  return expected.every((value) => actual.includes(value));
}

function sameNames(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function summarizeOp(operation: Operation): unknown {
  if (operation.kind === "logic-edit") {
    return { kind: operation.kind, name: operation.symbol.name, edits: operation.edits };
  }
  return operation;
}

describe("unchanged and renamed bodies", () => {
  const snapshot = (label: string, files: Record<string, string>) => ({
    label,
    files: Object.entries(files).map(([file, text]) => ({ path: file, text })),
  });
  const kinds = (report: ReturnType<typeof analyzeSnapshots>) =>
    report.operations.map((operation) => `${operation.kind}:${"symbol" in operation ? operation.symbol.name : "to" in operation ? operation.to.name : ""}`).sort();

  it("reports nothing for files identical on both sides", () => {
    const text = "export function a(x: number) {\n  return x + 1;\n}\nexport class C {\n  n = 1;\n  m() {\n    return a(this.n);\n  }\n}\n";
    const report = analyzeSnapshots(snapshot("l", { "a.ts": text, "b.ts": text }), snapshot("r", { "a.ts": text, "b.ts": text }), { embedSources: false });
    expect(report.operations).toEqual([]);
  });

  it("follows a body that moved to another name instead of the anchor", () => {
    const report = analyzeSnapshots(
      snapshot("l", { "m.ts": "export function foo(a: number) {\n  return a * 2 + 7;\n}\n" }),
      snapshot("r", {
        "m.ts": "export function foo(a: number) {\n  return a - 1;\n}\nexport function bar(a: number) {\n  return a * 2 + 7;\n}\n",
      }),
      { embedSources: false },
    );
    expect(kinds(report)).toEqual(["add:foo", "rename:bar"]);
  });

  it("only flags callers whose text disagrees with a rename", () => {
    const left = "export function foo(a: number) {\n  return a * 2 + 7;\n}\nexport function updated() {\n  return foo(1);\n}\nexport function stale() {\n  return foo(2);\n}\n";
    const right = "export function bar(a: number) {\n  return a * 2 + 7;\n}\nexport function updated() {\n  return bar(1);\n}\nexport function stale() {\n  return foo(2);\n}\n";
    const report = analyzeSnapshots(snapshot("l", { "m.ts": left }), snapshot("r", { "m.ts": right }), { embedSources: false });
    expect(kinds(report)).toEqual(["logic-edit:stale", "rename:bar"]);
  });
});
