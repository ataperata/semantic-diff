import { sha1 } from "../hash.js";
import { spanFromTreeSitter, type Span } from "../span.js";
import type { SyntaxNode } from "./native.js";

export interface IrNode {
  type: string;
  text: string | null;
  children: IrNode[];
  span: Span;
}

const COMMENT_TYPES = new Set(["comment", "line_comment", "block_comment"]);

function isPunctuation(text: string): boolean {
  return text.length > 0 && /^[()[\]{},.;:`'"]+$/.test(text);
}

export function toIr(node: SyntaxNode): IrNode | null {
  if (COMMENT_TYPES.has(node.type)) return null;
  if (!node.isNamed) {
    if (isPunctuation(node.text) || node.text.trim() === "") return null;
    return {
      type: "token",
      text: node.text,
      children: [],
      span: spanFromTreeSitter(node.startPosition, node.endPosition),
    };
  }
  const children: IrNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const ir = toIr(child);
    if (ir) children.push(ir);
  }
  return {
    type: node.type,
    text: children.length === 0 ? node.text : null,
    children,
    span: spanFromTreeSitter(node.startPosition, node.endPosition),
  };
}

export function irKey(node: IrNode): string {
  if (node.children.length === 0) return node.type + ":" + (node.text ?? "");
  return node.type + "(" + node.children.map(irKey).join(",") + ")";
}

export function statementNodes(body: IrNode): IrNode[] {
  if (body.type === "statement_block" || body.type === "block" || body.type === "class_members") {
    return body.children.filter((child) => child.type !== "token");
  }
  return [body];
}

export function skeletonsOf(statements: IrNode[], bound: ReadonlySet<string>): string[] {
  return statements.map((statement) => skeleton(statement, bound));
}

function skeleton(node: IrNode, bound: ReadonlySet<string>): string {
  const names = new Map<string, string>();
  const walk = (current: IrNode): string => {
    if (current.type === "identifier" && current.text && bound.has(current.text)) {
      let id = names.get(current.text);
      if (!id) {
        id = "$" + names.size;
        names.set(current.text, id);
      }
      return id;
    }
    if (current.children.length === 0) return current.type + ":" + (current.text ?? "");
    return current.type + "(" + current.children.map(walk).join(",") + ")";
  };
  return walk(node);
}

export function structuralHash(node: IrNode, bound: ReadonlySet<string>): string {
  const names = new Map<string, string>();
  const walk = (current: IrNode): string => {
    if (current.type === "identifier" && current.text && bound.has(current.text)) {
      let id = names.get(current.text);
      if (!id) {
        id = "$" + names.size;
        names.set(current.text, id);
      }
      return id;
    }
    if (current.children.length === 0) return current.type + ":" + (current.text ?? "");
    return current.type + "(" + current.children.map(walk).join(",") + ")";
  };
  return sha1(walk(node));
}

export function rewriteNames(
  node: IrNode,
  bound: ReadonlySet<string>,
  functionRenames: ReadonlyMap<string, string>,
  methodRenames: ReadonlyMap<string, string>,
): IrNode {
  const rewrite = (current: IrNode, parent: IrNode | null): IrNode => {
    let text = current.text;
    const significant = parent ? parent.children.filter((child) => child.type !== "token") : [];
    const isProperty =
      parent !== null &&
      (parent.type === "attribute" || parent.type === "member_expression") &&
      significant.length >= 2 &&
      significant[significant.length - 1] === current;
    if (text && (current.type === "property_identifier" || isProperty) && methodRenames.has(text)) {
      text = methodRenames.get(text) ?? text;
    } else if (current.type === "identifier" && text && !bound.has(text) && functionRenames.has(text)) {
      text = functionRenames.get(text) ?? text;
    }
    const next: IrNode = { type: current.type, text, children: [], span: current.span };
    next.children = current.children.map((child) => rewrite(child, current));
    return next;
  };
  return rewrite(node, null);
}

export function findContiguous(host: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > host.length) return -1;
  outer: for (let start = 0; start + needle.length <= host.length; start++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (host[start + offset] !== needle[offset]) continue outer;
    }
    return start;
  }
  return -1;
}

export function isSimpleReturn(statement: IrNode): boolean {
  if (statement.type !== "return_statement") return false;
  const significant = statement.children.filter((child) => child.type !== "token");
  return significant.length === 1 && significant[0]?.type === "identifier";
}

export function nodeLabel(node: IrNode): string {
  if (node.text && node.children.length === 0) return node.text;
  const parts: string[] = [];
  const walk = (current: IrNode): void => {
    if (parts.join(" ").length > 120) return;
    if (current.children.length === 0) {
      if (current.text) parts.push(current.text);
      return;
    }
    for (const child of current.children) walk(child);
  };
  walk(node);
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text.length > 100 ? text.slice(0, 97) + "..." : text;
}
