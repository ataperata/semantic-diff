import { describe, expect, it } from "vitest";
import { diffTrees, type DiffNode } from "../src/diff/treeDiff.js";
import type { Span } from "../src/span.js";

const span: Span = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };

function leaf(type: string, text: string, line = 1): DiffNode {
  return {
    type,
    text,
    children: [],
    span: { start: { line, column: 1 }, end: { line, column: 1 + text.length } },
  };
}

function node(type: string, children: DiffNode[], line = 1): DiffNode {
  return { type, text: null, children, span: { ...span, start: { line, column: 1 } } };
}

describe("tree diff", () => {
  it("emits nothing for identical trees", () => {
    const tree = node("block", [leaf("number", "1"), leaf("number", "2", 2)]);
    expect(diffTrees(tree, tree)).toEqual([]);
  });

  it("updates a single changed literal", () => {
    const before = node("binary", [leaf("identifier", "total"), leaf("token", ">"), leaf("number", "50")]);
    const after = node("binary", [leaf("identifier", "total"), leaf("token", ">"), leaf("number", "75")]);
    const edits = diffTrees(before, after);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ op: "update", before: { text: "50" }, after: { text: "75" } });
  });

  it("inserts one new statement instead of rewriting the block", () => {
    const before = node("block", [leaf("statement", "keep", 1)]);
    const after = node("block", [leaf("statement", "keep", 1), leaf("statement", "added", 2)]);
    const edits = diffTrees(before, after);
    expect(edits.map((edit) => edit.op)).toEqual(["insert"]);
    expect(edits[0]?.after?.text).toBe("added");
  });

  it("deletes one removed statement", () => {
    const before = node("block", [leaf("statement", "keep", 1), leaf("statement", "gone", 2)]);
    const after = node("block", [leaf("statement", "keep", 1)]);
    const edits = diffTrees(before, after);
    expect(edits.map((edit) => edit.op)).toEqual(["delete"]);
    expect(edits[0]?.before?.text).toBe("gone");
  });

  it("represents a swap as a single move", () => {
    const before = node("block", [leaf("statement", "alpha", 1), leaf("statement", "beta", 2)]);
    const after = node("block", [leaf("statement", "beta", 1), leaf("statement", "alpha", 2)]);
    const edits = diffTrees(before, after);
    expect(edits.map((edit) => edit.op)).toEqual(["move"]);
  });

  it("updates a literal nested in parentheses", () => {
    const before = node("if", [
      node("paren", [node("binary", [leaf("identifier", "total"), leaf("token", ">"), leaf("number", "50")])]),
    ]);
    const after = node("if", [
      node("paren", [node("binary", [leaf("identifier", "total"), leaf("token", ">"), leaf("number", "75")])]),
    ]);
    const edits = diffTrees(before, after);
    expect(edits.map((edit) => edit.op)).toEqual(["update"]);
    expect(edits[0]).toMatchObject({ before: { text: "50" }, after: { text: "75" } });
  });

  it("updates an operator without replacing the expression", () => {
    const before = node("binary", [leaf("identifier", "weight"), leaf("token", "*"), leaf("number", "2")]);
    const after = node("binary", [leaf("identifier", "weight"), leaf("token", "+"), leaf("number", "2")]);
    const edits = diffTrees(before, after);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ op: "update", nodeType: "token", before: { text: "*" }, after: { text: "+" } });
  });
});
