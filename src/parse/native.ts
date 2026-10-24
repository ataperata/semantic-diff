import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface TsPoint {
  row: number;
  column: number;
}

export interface SyntaxNode {
  type: string;
  text: string;
  isNamed: boolean;
  hasError: boolean;
  childCount: number;
  namedChildCount: number;
  startPosition: TsPoint;
  endPosition: TsPoint;
  parent: SyntaxNode | null;
  children: SyntaxNode[];
  child(index: number): SyntaxNode | null;
  namedChildren: SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
}

interface TreeParser {
  setLanguage(language: unknown): void;
  parse(source: string): { rootNode: SyntaxNode };
}

export type Grammar = "typescript" | "tsx" | "python";

let typescriptParser: TreeParser | null = null;
let pythonParser: TreeParser | null = null;

function makeParser(grammar: Grammar): TreeParser {
  const Parser = require("tree-sitter") as new () => TreeParser;
  const parser = new Parser();
  if (grammar === "python") {
    parser.setLanguage(require("tree-sitter-python"));
  } else {
    const languages = require("tree-sitter-typescript") as {
      typescript: unknown;
      tsx: unknown;
    };
    parser.setLanguage(grammar === "tsx" ? languages.tsx : languages.typescript);
  }
  return parser;
}

export function parseSource(source: string, grammar: Grammar): SyntaxNode {
  const parser = grammar === "python" ? (pythonParser ??= makeParser("python")) : (typescriptParser ??= makeParser(grammar === "tsx" ? "tsx" : "typescript"));
  if (grammar !== "python") {
    const languages = require("tree-sitter-typescript") as { typescript: unknown; tsx: unknown };
    parser.setLanguage(grammar === "tsx" ? languages.tsx : languages.typescript);
  }
  return parser.parse(source).rootNode;
}
