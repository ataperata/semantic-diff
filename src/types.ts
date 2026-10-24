import type { Span } from "./span.js";

export type { Point, Span } from "./span.js";

export type Language = "typescript" | "python";
export type SymbolKind = "function" | "method" | "class";

export interface SymbolRef {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  file: string;
  span: Span;
}

export interface AstSnippet {
  text: string;
  span: Span;
}

export interface AstEdit {
  op: "insert" | "delete" | "update" | "move";
  nodeType: string;
  before?: AstSnippet;
  after?: AstSnippet;
}

export interface ParamChange {
  name: string;
  from: string;
  to: string;
}

export interface OrderedSymbol {
  name: string;
  qualifiedName: string;
  span: Span;
}

export type Operation =
  | {
      kind: "rename";
      symbolKind: SymbolKind;
      from: SymbolRef;
      to: SymbolRef;
      callSitesUpdated: number;
      importsUpdated: number;
      confidence: number;
    }
  | {
      kind: "move";
      symbolKind: SymbolKind;
      from: SymbolRef;
      to: SymbolRef;
      importsUpdated: number;
      confidence: number;
    }
  | {
      kind: "rename-move";
      symbolKind: SymbolKind;
      from: SymbolRef;
      to: SymbolRef;
      callSitesUpdated: number;
      importsUpdated: number;
      confidence: number;
    }
  | {
      kind: "extract";
      source: SymbolRef;
      host: SymbolRef;
      extracted: SymbolRef;
      confidence: number;
    }
  | {
      kind: "inline";
      source: SymbolRef;
      hostBefore: SymbolRef;
      hostAfter: SymbolRef;
      confidence: number;
    }
  | {
      kind: "signature-change";
      symbolKind: SymbolKind;
      name: string;
      qualifiedName: string;
      from: SymbolRef;
      to: SymbolRef;
      addedParams: string[];
      removedParams: string[];
      changedParams: ParamChange[];
      parameterOrder?: { from: string[]; to: string[] };
      returnType?: { from?: string; to?: string };
      async?: { from: boolean; to: boolean };
      bases?: { from: string[]; to: string[] };
      decorators?: { from: string[]; to: string[] };
      confidence: number;
    }
  | {
      kind: "reorder";
      scope: "file" | "class";
      file: string;
      container?: string;
      before: OrderedSymbol[];
      after: OrderedSymbol[];
      confidence: number;
    }
  | {
      kind: "logic-edit";
      symbol: SymbolRef;
      before: SymbolRef;
      edits: AstEdit[];
      confidence: number;
    }
  | {
      kind: "add";
      symbol: SymbolRef;
      confidence: number;
    }
  | {
      kind: "remove";
      symbol: SymbolRef;
      confidence: number;
    };

export interface Highlight {
  opIndex: number;
  side: "left" | "right";
  file: string;
  span: Span;
  kind: Operation["kind"];
}

export type FileStatus = "added" | "deleted" | "modified" | "formatting-only" | "unchanged";

export interface FileEntry {
  path: string;
  status: FileStatus;
  language?: Language;
}

export interface ParseDiagnostic {
  file: string;
  side: "left" | "right";
  message: string;
}

export interface Report {
  tool: "semantic-diff";
  version: 1;
  left: { label: string };
  right: { label: string };
  summary: string;
  summaryLines: string[];
  stats: {
    operations: number;
    byKind: Record<string, number>;
    formattingOnlyFiles: number;
    filesCompared: number;
    filesChanged: number;
  };
  operations: Operation[];
  ignoredFormatting: { file: string; reason: string }[];
  files: FileEntry[];
  parseDiagnostics: ParseDiagnostic[];
  highlights: Highlight[];
  sources?: {
    left: Record<string, string>;
    right: Record<string, string>;
  };
  debug?: {
    symbols: Array<{
      side: "left" | "right";
      file: string;
      name: string;
      qualifiedName: string;
      kind: SymbolKind;
      calls: string[];
      skeletons: string[];
      bodyHash: string;
    }>;
  };
}

export interface SourceFile {
  path: string;
  text: string;
}

export interface Snapshot {
  label: string;
  files: SourceFile[];
}

export interface AnalyzeOptions {
  /** Embed file text for changed files so the web viewer can render them. Default true. */
  embedSources?: boolean;
  leftLabel?: string;
  rightLabel?: string;
  /** Include per-symbol skeletons in the report under `debug`. */
  debug?: boolean;
}
