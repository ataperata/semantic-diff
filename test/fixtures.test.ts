import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzePaths } from "../src/index.js";
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
