export interface Point {
  /** 1-based line number. */
  line: number;
  /** 1-based column. End columns are exclusive. */
  column: number;
}

export interface Span {
  start: Point;
  end: Point;
}

export function spanFromTreeSitter(
  start: { row: number; column: number },
  end: { row: number; column: number },
): Span {
  return {
    start: { line: start.row + 1, column: start.column + 1 },
    end: { line: end.row + 1, column: end.column + 1 },
  };
}

export function pointLE(a: Point, b: Point): boolean {
  if (a.line !== b.line) return a.line < b.line;
  return a.column <= b.column;
}

export function spanContains(outer: Span, inner: Span): boolean {
  return pointLE(outer.start, inner.start) && pointLE(inner.end, outer.end);
}

export function sourceSlice(source: string, span: Span, limit = 100): string {
  const lines = source.split("\n");
  const parts: string[] = [];
  const last = Math.min(span.end.line, lines.length);
  for (let line = span.start.line; line <= last; line++) {
    const text = lines[line - 1] ?? "";
    const startCol = line === span.start.line ? Math.max(0, span.start.column - 1) : 0;
    const endCol = line === span.end.line ? Math.max(startCol, span.end.column - 1) : text.length;
    parts.push(text.slice(startCol, endCol));
  }
  const collapsed = parts.join(" ").replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return collapsed.slice(0, limit - 3) + "...";
}

export function earlierSpan(a: Span, b: Span): number {
  if (a.start.line !== b.start.line) return a.start.line - b.start.line;
  return a.start.column - b.start.column;
}
