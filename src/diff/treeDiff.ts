import { sha1 } from "../hash.js";
import type { Span } from "../span.js";
import type { AstEdit } from "../types.js";

export interface DiffNode {
  type: string;
  text: string | null;
  children: DiffNode[];
  span: Span;
}

interface Indexed {
  type: string;
  text: string | null;
  children: Indexed[];
  span: Span;
  hash: string;
  id: number;
  parent: Indexed | null;
}

function indexTree(node: DiffNode, parent: Indexed | null, bag: Indexed[]): Indexed {
  const self: Indexed = {
    type: node.type,
    text: node.text,
    children: [],
    span: node.span,
    hash: "",
    id: bag.length,
    parent,
  };
  bag.push(self);
  self.children = node.children.map((child) => indexTree(child, self, bag));
  const body = self.type + "\0" + (self.text ?? "") + "\0" + self.children.map((child) => child.hash).join(",");
  self.hash = sha1(body);
  return self;
}

function labelOf(node: Indexed): string {
  if (node.text && node.children.length === 0) return node.text;
  const parts: string[] = [];
  const walk = (current: Indexed): void => {
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

function dice(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const value of right) counts.set(value, (counts.get(value) ?? 0) + 1);
  let overlap = 0;
  for (const value of left) {
    const count = counts.get(value) ?? 0;
    if (count > 0) {
      overlap++;
      counts.set(value, count - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length);
}

function similarity(left: Indexed, right: Indexed): number {
  if (left.hash === right.hash) return 1;
  if (left.type !== right.type) return 0;
  if (left.children.length === 0 && right.children.length === 0) {
    return left.text === right.text ? 1 : 0.55;
  }
  const hashDice = dice(
    left.children.map((child) => child.hash),
    right.children.map((child) => child.hash),
  );
  // Same child shapes (a parenthesized comparison whose literal changed, for
  // example) should still align so the edit collapses to the changed leaf.
  const shapeDice = dice(
    left.children.map((child) => child.type),
    right.children.map((child) => child.type),
  );
  return Math.max(hashDice, shapeDice * 0.75);
}

function lisMembers(values: readonly number[]): Set<number> {
  const previous = new Array<number>(values.length).fill(-1);
  const tails: number[] = [];
  for (let index = 0; index < values.length; index++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (values[tails[mid] ?? 0] < values[index]) low = mid + 1;
      else high = mid;
    }
    if (low > 0) previous[index] = tails[low - 1] ?? -1;
    if (low === tails.length) tails.push(index);
    else tails[low] = index;
  }
  const members = new Set<number>();
  let cursor = tails.length ? tails[tails.length - 1] : -1;
  while (cursor !== undefined && cursor >= 0) {
    members.add(cursor);
    cursor = previous[cursor] ?? -1;
  }
  return members;
}

function lcsEqualHash(left: Indexed[], right: Indexed[]): Array<[Indexed, Indexed]> {
  const rows = left.length;
  const cols = right.length;
  const scores: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      if (left[i]?.hash === right[j]?.hash) scores[i][j] = (scores[i + 1]?.[j + 1] ?? 0) + 1;
      else scores[i][j] = Math.max(scores[i + 1]?.[j] ?? 0, scores[i]?.[j + 1] ?? 0);
    }
  }
  const pairs: Array<[Indexed, Indexed]> = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (left[i]?.hash === right[j]?.hash) {
      pairs.push([left[i] as Indexed, right[j] as Indexed]);
      i++;
      j++;
    } else if ((scores[i + 1]?.[j] ?? 0) >= (scores[i]?.[j + 1] ?? 0)) i++;
    else j++;
  }
  return pairs;
}

/**
 * Ordered tree diff. Identical subtrees anchor even when they move, leftover
 * siblings match by shape, and sibling order changes become the minimum set of
 * moves (nodes outside the longest increasing subsequence).
 */
export function diffTrees(before: DiffNode, after: DiffNode): AstEdit[] {
  const leftBag: Indexed[] = [];
  const rightBag: Indexed[] = [];
  const leftRoot = indexTree(before, null, leftBag);
  const rightRoot = indexTree(after, null, rightBag);
  const leftToRight = new Map<number, number>();
  const rightToLeft = new Map<number, number>();
  const leftById = new Map(leftBag.map((node) => [node.id, node]));
  const rightById = new Map(rightBag.map((node) => [node.id, node]));

  const link = (left: Indexed, right: Indexed): void => {
    leftToRight.set(left.id, right.id);
    rightToLeft.set(right.id, left.id);
  };

  const linkIdentical = (left: Indexed, right: Indexed): void => {
    link(left, right);
    for (let i = 0; i < left.children.length; i++) {
      const child = left.children[i];
      const other = right.children[i];
      if (child && other) linkIdentical(child, other);
    }
  };

  const align = (left: Indexed, right: Indexed): void => {
    const usedLeft = new Set<number>();
    const usedRight = new Set<number>();
    const countHash = (nodes: Indexed[], hash: string) => nodes.filter((node) => node.hash === hash).length;

    for (const child of left.children) {
      if (countHash(left.children, child.hash) !== 1) continue;
      const candidates = right.children.filter((other) => other.hash === child.hash && !usedRight.has(other.id));
      if (candidates.length === 1 && candidates[0]) {
        linkIdentical(child, candidates[0]);
        usedLeft.add(child.id);
        usedRight.add(candidates[0].id);
      }
    }

    const remainingLeft = left.children.filter((child) => !usedLeft.has(child.id));
    const remainingRight = right.children.filter((child) => !usedRight.has(child.id));
    for (const [child, other] of lcsEqualHash(remainingLeft, remainingRight)) {
      linkIdentical(child, other);
      usedLeft.add(child.id);
      usedRight.add(other.id);
    }

    const stillLeft = left.children.filter((child) => !usedLeft.has(child.id));
    const stillRight = right.children.filter((child) => !usedRight.has(child.id));
    const pairs: Array<{ left: Indexed; right: Indexed; score: number }> = [];
    for (const child of stillLeft) {
      for (const other of stillRight) {
        const score = similarity(child, other);
        if (child.type === other.type && score >= 0.5) pairs.push({ left: child, right: other, score });
      }
    }
    pairs.sort((a, b) => b.score - a.score || a.left.id - b.left.id || a.right.id - b.right.id);
    for (const pair of pairs) {
      if (usedLeft.has(pair.left.id) || usedRight.has(pair.right.id)) continue;
      link(pair.left, pair.right);
      usedLeft.add(pair.left.id);
      usedRight.add(pair.right.id);
      align(pair.left, pair.right);
    }
  };

  if (leftRoot.type !== rightRoot.type) {
    return [
      { op: "delete", nodeType: leftRoot.type, before: { text: labelOf(leftRoot), span: leftRoot.span } },
      { op: "insert", nodeType: rightRoot.type, after: { text: labelOf(rightRoot), span: rightRoot.span } },
    ];
  }

  link(leftRoot, rightRoot);
  align(leftRoot, rightRoot);

  const edits: AstEdit[] = [];
  for (const [leftId, rightId] of leftToRight) {
    const left = leftById.get(leftId);
    const right = rightById.get(rightId);
    if (!left || !right) continue;
    if (left.children.length === 0 && right.children.length === 0 && (left.text !== right.text || left.type !== right.type)) {
      edits.push({
        op: "update",
        nodeType: left.type,
        before: { text: left.text ?? "", span: left.span },
        after: { text: right.text ?? "", span: right.span },
      });
    }
  }

  const walkDeletes = (node: Indexed): void => {
    if (!leftToRight.has(node.id)) {
      if (!node.parent || leftToRight.has(node.parent.id)) {
        edits.push({ op: "delete", nodeType: node.type, before: { text: labelOf(node), span: node.span } });
      }
      return;
    }
    for (const child of node.children) walkDeletes(child);
  };
  const walkInserts = (node: Indexed): void => {
    if (!rightToLeft.has(node.id)) {
      if (!node.parent || rightToLeft.has(node.parent.id)) {
        edits.push({ op: "insert", nodeType: node.type, after: { text: labelOf(node), span: node.span } });
      }
      return;
    }
    for (const child of node.children) walkInserts(child);
  };
  walkDeletes(leftRoot);
  walkInserts(rightRoot);

  for (const [leftId, rightId] of leftToRight) {
    const left = leftById.get(leftId);
    const right = rightById.get(rightId);
    if (!left || !right) continue;
    const paired: Array<{ left: Indexed; right: Indexed; index: number }> = [];
    for (const child of left.children) {
      const mapped = leftToRight.get(child.id);
      if (mapped === undefined) continue;
      const other = rightById.get(mapped);
      if (!other || other.parent !== right) continue;
      const index = right.children.findIndex((candidate) => candidate.id === other.id);
      if (index >= 0) paired.push({ left: child, right: other, index });
    }
    const kept = lisMembers(paired.map((pair) => pair.index));
    for (let i = 0; i < paired.length; i++) {
      const pair = paired[i];
      if (!pair || kept.has(i)) continue;
      if (pair.left.hash !== pair.right.hash) continue;
      edits.push({
        op: "move",
        nodeType: pair.left.type,
        before: { text: labelOf(pair.left), span: pair.left.span },
        after: { text: labelOf(pair.right), span: pair.right.span },
      });
    }
  }

  for (const [leftId, rightId] of leftToRight) {
    const left = leftById.get(leftId);
    const right = rightById.get(rightId);
    if (!left?.parent || !right?.parent) continue;
    const mappedParent = leftToRight.get(left.parent.id);
    if (mappedParent === right.parent.id) continue;
    if (left.hash !== right.hash) continue;
    edits.push({
      op: "move",
      nodeType: left.type,
      before: { text: labelOf(left), span: left.span },
      after: { text: labelOf(right), span: right.span },
    });
  }

  const startOf = (edit: AstEdit): number => {
    const span = edit.before?.span ?? edit.after?.span;
    if (!span) return 0;
    return span.start.line * 100000 + span.start.column;
  };
  edits.sort((a, b) => startOf(a) - startOf(b) || a.op.localeCompare(b.op) || a.nodeType.localeCompare(b.nodeType));
  return edits;
}

export function toDiffNode(node: { type: string; text: string | null; children: DiffNode[]; span: Span }): DiffNode {
  return node;
}
