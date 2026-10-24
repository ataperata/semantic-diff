import { sha1 } from "../hash.js";
import { spanContains, spanFromTreeSitter, type Span } from "../span.js";
import type { Language, SymbolKind } from "../types.js";
import { irKey, skeletonsOf, statementNodes, structuralHash, toIr, type IrNode } from "./ir.js";
import { parseSource, type Grammar, type SyntaxNode } from "./native.js";

export interface Param {
  name: string;
  type?: string;
  optional: boolean;
  rest: boolean;
  default?: string;
}

export interface Signature {
  params: Param[];
  returnType?: string;
  async: boolean;
  decorators: string[];
  bases: string[];
}

export interface Symbol {
  id: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  parent?: string;
  file: string;
  language: Language;
  span: Span;
  signature: Signature;
  body: IrNode;
  statements: IrNode[];
  skeletons: string[];
  stmtSpans: Span[];
  bodyHash: string;
  calls: string[];
  bound: string[];
  fieldKey: string;
}

export interface ImportSite {
  imported: string;
  local: string;
  spec: string;
  resolved: string;
  span: Span;
}

export interface CallSite {
  name: string;
  form: "call" | "method";
  span: Span;
}

export interface ParsedFile {
  path: string;
  language: Language;
  text: string;
  symbols: Symbol[];
  imports: ImportSite[];
  calls: CallSite[];
  treeKey: string;
  diagnostics: string[];
}

export function grammarOf(file: string): Grammar | null {
  if (file.endsWith(".tsx")) return "tsx";
  if (/\.(ts|mts|cts)$/.test(file)) return "typescript";
  if (file.endsWith(".py")) return "python";
  return null;
}

export function languageOf(file: string): Language | null {
  const grammar = grammarOf(file);
  if (!grammar) return null;
  return grammar === "python" ? "python" : "typescript";
}

export function parseFile(file: string, text: string): ParsedFile | null {
  const grammar = grammarOf(file);
  if (!grammar) return null;
  const language: Language = grammar === "python" ? "python" : "typescript";
  const diagnostics: string[] = [];
  let root: SyntaxNode;
  try {
    root = parseSource(text, grammar);
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
    return {
      path: file,
      language,
      text,
      symbols: [],
      imports: [],
      calls: [],
      treeKey: "",
      diagnostics,
    };
  }
  if (root.hasError) diagnostics.push("parser recovered from a syntax error; symbol matching may be incomplete");
  const tree = toIr(root);
  const symbols = extractSymbols(file, language, grammar, root);
  return {
    path: file,
    language,
    text,
    symbols,
    imports: extractImports(root, file, grammar),
    calls: extractCallSites(root, grammar),
    treeKey: tree ? irKey(tree) : "",
    diagnostics,
  };
}

export function resolveModule(file: string, spec: string, level: number, language: Language): string {
  const normalized = file.replace(/\\/g, "/");
  if (language === "typescript") {
    if (!spec.startsWith(".")) return spec;
    return normalizePosix(joinPosix(dirnamePosix(normalized), spec));
  }
  const parts = spec.split(".").filter(Boolean);
  if (level <= 0) return parts.join("/");
  let dir = dirnamePosix(normalized);
  for (let i = 1; i < level; i++) dir = dirnamePosix(dir);
  return normalizePosix(joinPosix(dir, ...parts));
}

export function moduleMatchesFile(resolved: string, file: string): boolean {
  return stem(resolved) === stem(file);
}

function stem(file: string): string {
  return file.replace(/\\/g, "/").replace(/\.(tsx?|mts|cts|pyi?)$/, "").replace(/\/index$/, "");
}

function dirnamePosix(file: string): string {
  const index = file.lastIndexOf("/");
  return index <= 0 ? "." : file.slice(0, index);
}

function joinPosix(...parts: string[]): string {
  return parts.filter(Boolean).join("/");
}

function normalizePosix(file: string): string {
  const parts: string[] = [];
  for (const part of file.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function extractSymbols(file: string, language: Language, grammar: Grammar, root: SyntaxNode): Symbol[] {
  const symbols: Symbol[] = [];
  const visit = (node: SyntaxNode, parent?: string, decorators: string[] = []): void => {
    if (node.type === "program" || node.type === "module") {
      for (const child of node.children) visit(child, parent, decorators);
      return;
    }
    if (node.type === "export_statement") {
      for (const child of node.namedChildren) visit(child, parent, decorators);
      return;
    }
    if (node.type === "decorated_definition") {
      const found = node.children.filter((child) => child.type === "decorator").map((child) => collapse(child.text));
      for (const child of node.children) {
        if (child.type === "function_definition" || child.type === "class_definition") visit(child, parent, found);
      }
      return;
    }
    if (node.type === "class_declaration" || node.type === "class_definition") {
      const created = makeClass(node, file, language, grammar, decorators);
      if (created) {
        symbols.push(created);
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.children) visit(child, created.name, []);
        }
      }
      return;
    }
    if (node.type === "function_declaration" || node.type === "function_definition" || node.type === "method_definition") {
      const kind: SymbolKind = parent || node.type === "method_definition" ? "method" : "function";
      const created = makeFunction(node, kind, parent, file, language, grammar, decorators.concat(decoratorList(node)));
      if (created) symbols.push(created);
      return;
    }
    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (const child of node.children) {
        if (child.type !== "variable_declarator") continue;
        const created = makeDeclarator(child, parent, file, language, grammar);
        if (created) symbols.push(created);
      }
      return;
    }
    if (node.type === "public_field_definition") {
      const created = makeDeclarator(node, parent, file, language, grammar);
      if (created) symbols.push(created);
    }
  };
  visit(root);
  for (const symbol of symbols) {
    if (symbol.kind !== "class") continue;
    const methods = symbols.filter(
      (candidate) => candidate.kind === "method" && candidate.file === symbol.file && spanContains(symbol.span, candidate.span),
    );
    symbol.bodyHash = sha1(["class", JSON.stringify(symbol.signature), symbol.fieldKey, ...methods.map((method) => method.bodyHash)].join("|"));
  }
  return symbols;
}

function makeClass(
  node: SyntaxNode,
  file: string,
  language: Language,
  grammar: Grammar,
  decorators: string[],
): Symbol | null {
  const name = readIdentifier(node) ?? "anonymous";
  const bodyNode = node.childForFieldName("body");
  const fields: IrNode[] = [];
  if (bodyNode) {
    for (const child of bodyNode.children) {
      if (isNestedSymbol(child)) continue;
      const ir = toIr(child);
      if (ir) fields.push(ir);
    }
  }
  const span = spanFromTreeSitter(node.startPosition, node.endPosition);
  const body: IrNode = {
    type: "class_members",
    text: null,
    children: fields,
    span: bodyNode ? spanFromTreeSitter(bodyNode.startPosition, bodyNode.endPosition) : span,
  };
  const signature: Signature = {
    params: [],
    async: false,
    decorators,
    bases: readBases(node, grammar),
  };
  return finishSymbol({
    name,
    qualifiedName: name,
    kind: "class",
    file,
    language,
    span,
    signature,
    body,
    syntaxBody: null,
    grammar,
    selfName: name,
  });
}

function makeFunction(
  node: SyntaxNode,
  kind: SymbolKind,
  parent: string | undefined,
  file: string,
  language: Language,
  grammar: Grammar,
  decorators: string[],
): Symbol | null {
  const name = readIdentifier(node);
  const bodyNode = node.childForFieldName("body");
  if (!name || !bodyNode) return null;
  const body = toIr(bodyNode);
  if (!body) return null;
  const paramsNode = node.childForFieldName("parameters") ?? node.children.find((child) => child.type === "formal_parameters" || child.type === "parameters") ?? null;
  const signature: Signature = {
    params: readParams(paramsNode, grammar),
    returnType: flat(node.childForFieldName("return_type")),
    async: hasKeyword(node, "async"),
    decorators,
    bases: [],
  };
  return finishSymbol({
    name,
    qualifiedName: parent ? `${parent}.${name}` : name,
    kind,
    parent,
    file,
    language,
    span: spanFromTreeSitter(node.startPosition, node.endPosition),
    signature,
    body,
    syntaxBody: bodyNode,
    grammar,
    selfName: name,
  });
}

function makeDeclarator(
  node: SyntaxNode,
  parent: string | undefined,
  file: string,
  language: Language,
  grammar: Grammar,
): Symbol | null {
  const nameNode = node.childForFieldName("name");
  const value = node.childForFieldName("value");
  if (!nameNode || !value) return null;
  if (value.type !== "arrow_function" && value.type !== "function_expression") return null;
  const name =
    nameNode.type === "identifier" || nameNode.type === "property_identifier"
      ? nameNode.text
      : readIdentifier(nameNode);
  const bodyNode = value.childForFieldName("body");
  if (!name || !bodyNode) return null;
  const body = toIr(bodyNode);
  if (!body) return null;
  const paramsNode = value.childForFieldName("parameters");
  return finishSymbol({
    name,
    qualifiedName: parent ? `${parent}.${name}` : name,
    kind: parent ? "method" : "function",
    parent,
    file,
    language,
    span: spanFromTreeSitter(node.startPosition, node.endPosition),
    signature: {
      params: readParams(paramsNode, grammar),
      returnType: flat(value.childForFieldName("return_type")),
      async: hasKeyword(value, "async"),
      decorators: [],
      bases: [],
    },
    body,
    syntaxBody: bodyNode,
    grammar,
    selfName: name,
  });
}

interface FinishInput {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  parent?: string;
  file: string;
  language: Language;
  span: Span;
  signature: Signature;
  body: IrNode;
  syntaxBody: SyntaxNode | null;
  grammar: Grammar;
  selfName: string;
}

function finishSymbol(input: FinishInput): Symbol {
  const bound = new Set<string>(input.signature.params.map((param) => param.name));
  bound.add(input.selfName);
  if (input.syntaxBody) collectBindings(input.syntaxBody, input.grammar, bound);
  const statements = statementNodes(input.body);
  const skeletons = skeletonsOf(statements, bound);
  const calls = input.syntaxBody ? unique(collectBodyCalls(input.syntaxBody, input.grammar)) : [];
  const symbol: Symbol = {
    id: `${input.file}:${input.kind}:${input.qualifiedName}:${input.span.start.line}:${input.span.start.column}`,
    name: input.name,
    qualifiedName: input.qualifiedName,
    kind: input.kind,
    file: input.file,
    language: input.language,
    span: input.span,
    signature: input.signature,
    body: input.body,
    statements,
    skeletons,
    stmtSpans: statements.map((statement) => statement.span),
    bodyHash: structuralHash(input.body, bound),
    calls,
    bound: [...bound],
    fieldKey: irKey(input.body),
  };
  if (input.parent) symbol.parent = input.parent;
  return symbol;
}

function isNestedSymbol(node: SyntaxNode): boolean {
  if (
    node.type === "method_definition" ||
    node.type === "function_definition" ||
    node.type === "function_declaration" ||
    node.type === "decorated_definition"
  ) {
    return true;
  }
  if (node.type === "public_field_definition") {
    const value = node.childForFieldName("value");
    return Boolean(value && (value.type === "arrow_function" || value.type === "function_expression"));
  }
  return false;
}

function isFunctionNode(node: SyntaxNode): boolean {
  return (
    node.type === "function_declaration" ||
    node.type === "function_definition" ||
    node.type === "function_expression" ||
    node.type === "arrow_function" ||
    node.type === "method_definition" ||
    node.type === "lambda"
  );
}

function readIdentifier(node: SyntaxNode): string | undefined {
  const named = node.childForFieldName("name");
  if (named && (named.type === "identifier" || named.type === "property_identifier" || named.type === "type_identifier")) {
    return named.text;
  }
  for (const child of node.children) {
    if (child.type === "identifier" || child.type === "property_identifier" || child.type === "type_identifier") return child.text;
  }
  return undefined;
}

function readParams(node: SyntaxNode | null, grammar: Grammar): Param[] {
  if (!node) return [];
  if (grammar === "python") return readPythonParams(node);
  return readTypeScriptParams(node);
}

function readTypeScriptParams(node: SyntaxNode): Param[] {
  const params: Param[] = [];
  for (const child of node.children) {
    if (child.type !== "required_parameter" && child.type !== "optional_parameter" && child.type !== "rest_parameter") continue;
    const name = readIdentifier(child) ?? "_";
    const typeNode = child.childForFieldName("type");
    const value = child.childForFieldName("value");
    const optional = child.type === "optional_parameter" || Boolean(value) || child.children.some((part) => part.text === "?");
    const param: Param = {
      name,
      optional,
      rest: child.type === "rest_parameter",
    };
    const type = flat(typeNode);
    if (type) param.type = type;
    const fallback = value ? collapse(value.text) : undefined;
    if (fallback) param.default = fallback;
    params.push(param);
  }
  return params;
}

function readPythonParams(node: SyntaxNode): Param[] {
  const params: Param[] = [];
  for (const child of node.children) {
    if (child.type === "identifier") {
      params.push({ name: child.text, optional: false, rest: false });
      continue;
    }
    if (child.type === "typed_parameter" || child.type === "default_parameter" || child.type === "typed_default_parameter") {
      const name = readIdentifier(child);
      if (!name) continue;
      const param: Param = {
        name,
        optional: child.type !== "typed_parameter",
        rest: false,
      };
      const type = flat(child.childForFieldName("type"));
      if (type) param.type = type;
      const value = child.childForFieldName("value");
      if (value) param.default = collapse(value.text);
      params.push(param);
      continue;
    }
    if (child.type === "list_splat_pattern" || child.type === "dictionary_splat_pattern") {
      const name = readIdentifier(child) ?? (child.type === "list_splat_pattern" ? "args" : "kwargs");
      const param: Param = { name, optional: true, rest: true };
      const type = flat(child.childForFieldName("type"));
      if (type) param.type = type;
      params.push(param);
    }
  }
  return params;
}

function readBases(node: SyntaxNode, grammar: Grammar): string[] {
  if (grammar === "python") {
    const supers = node.childForFieldName("superclasses");
    if (!supers) return [];
    return supers.text
      .replace(/^\(/, "")
      .replace(/\)$/, "")
      .split(",")
      .map((part) => collapse(part))
      .filter(Boolean);
  }
  const heritage = node.children.find((child) => child.type === "class_heritage");
  if (!heritage) return [];
  const bases: string[] = [];
  for (const child of heritage.children) {
    if (child.type === "extends_clause") bases.push(collapse(child.text.replace(/^extends\s+/, "")));
    if (child.type === "implements_clause") bases.push("implements " + collapse(child.text.replace(/^implements\s+/, "")));
  }
  return bases.filter(Boolean);
}

function decoratorList(node: SyntaxNode): string[] {
  return node.children.filter((child) => child.type === "decorator").map((child) => collapse(child.text));
}

function collectBindings(node: SyntaxNode, grammar: Grammar, bound: Set<string>): void {
  if (isFunctionNode(node)) return;
  if (grammar !== "python") {
    if (node.type === "variable_declarator") {
      addPattern(node.childForFieldName("name"), bound);
      const value = node.childForFieldName("value");
      if (value) collectBindings(value, grammar, bound);
      return;
    }
    if (node.type === "catch_clause") {
      for (const child of node.children) {
        if (child.type === "statement_block") collectBindings(child, grammar, bound);
        else if (child.isNamed && child.type !== "identifier") addPattern(child, bound);
        else if (child.type === "identifier") bound.add(child.text);
      }
      return;
    }
  } else {
    if (node.type === "assignment" || node.type === "augmented_assignment") {
      addPattern(node.childForFieldName("left"), bound);
      const right = node.childForFieldName("right");
      if (right) collectBindings(right, grammar, bound);
      return;
    }
    if (node.type === "for_statement") addPattern(node.childForFieldName("left"), bound);
    if (node.type === "named_expression") {
      const name = node.childForFieldName("name");
      if (name?.type === "identifier") bound.add(name.text);
    }
  }
  for (const child of node.children) collectBindings(child, grammar, bound);
}

function addPattern(node: SyntaxNode | null, bound: Set<string>): void {
  if (!node) return;
  if (node.type === "identifier") {
    bound.add(node.text);
    return;
  }
  if (node.type === "member_expression" || node.type === "attribute" || node.type === "subscript") return;
  for (const child of node.namedChildren) addPattern(child, bound);
}

function collectBodyCalls(node: SyntaxNode, grammar: Grammar): string[] {
  const names: string[] = [];
  const walk = (current: SyntaxNode): void => {
    if (isFunctionNode(current)) return;
    if ((grammar === "python" && current.type === "call") || (grammar !== "python" && current.type === "call_expression")) {
      const callee = describeCallee(current.childForFieldName("function"));
      if (callee) names.push(callee.name);
    }
    for (const child of current.children) walk(child);
  };
  walk(node);
  return names;
}

function extractCallSites(root: SyntaxNode, grammar: Grammar): CallSite[] {
  const calls: CallSite[] = [];
  const walk = (node: SyntaxNode): void => {
    if ((grammar === "python" && node.type === "call") || (grammar !== "python" && node.type === "call_expression")) {
      const callee = describeCallee(node.childForFieldName("function"));
      if (callee) calls.push({ ...callee, span: spanFromTreeSitter(node.startPosition, node.endPosition) });
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return calls;
}

function describeCallee(node: SyntaxNode | null): { name: string; form: "call" | "method" } | null {
  if (!node) return null;
  if (node.type === "identifier") return { name: node.text, form: "call" };
  if (node.type === "member_expression") {
    const property = node.childForFieldName("property");
    return property ? { name: property.text, form: "method" } : null;
  }
  if (node.type === "attribute") {
    const property = node.childForFieldName("attribute");
    return property ? { name: property.text, form: "method" } : null;
  }
  return null;
}

function extractImports(root: SyntaxNode, file: string, grammar: Grammar): ImportSite[] {
  const imports: ImportSite[] = [];
  const walk = (node: SyntaxNode): void => {
    if (grammar === "python" && node.type === "import_from_statement") imports.push(...pythonFromImport(node, file));
    else if (grammar === "python" && node.type === "import_statement") imports.push(...pythonImport(node, file));
    else if (grammar !== "python" && node.type === "import_statement") imports.push(...typescriptImport(node, file));
    for (const child of node.children) walk(child);
  };
  walk(root);
  return imports;
}

function typescriptImport(node: SyntaxNode, file: string): ImportSite[] {
  const source = node.childForFieldName("source");
  const fragment = source?.children.find((child) => child.type === "string_fragment");
  const spec = fragment?.text ?? source?.text.replace(/^['"]|['"]$/g, "") ?? "";
  const resolved = resolveModule(file, spec, 0, "typescript");
  const span = spanFromTreeSitter(node.startPosition, node.endPosition);
  const clause = node.children.find((child) => child.type === "import_clause");
  if (!clause) return [];
  const sites: ImportSite[] = [];
  for (const child of clause.children) {
    if (child.type === "named_imports") {
      for (const specifier of child.children) {
        if (specifier.type !== "import_specifier") continue;
        const imported = specifier.childForFieldName("name")?.text ?? "";
        const local = specifier.childForFieldName("alias")?.text ?? imported;
        if (imported) sites.push({ imported, local, spec, resolved, span });
      }
    } else if (child.type === "namespace_import") {
      const local = [...child.children].reverse().find((part) => part.type === "identifier")?.text ?? "*";
      sites.push({ imported: "*", local, spec, resolved, span });
    } else if (child.type === "identifier") {
      sites.push({ imported: "default", local: child.text, spec, resolved, span });
    }
  }
  return sites;
}

function pythonFromImport(node: SyntaxNode, file: string): ImportSite[] {
  const moduleNode = node.childForFieldName("module_name");
  let spec = "";
  let level = 0;
  if (moduleNode?.type === "relative_import") {
    const prefix = moduleNode.children.find((child) => child.type === "import_prefix");
    level = prefix ? [...prefix.text].filter((char) => char === ".").length : 1;
    const dotted = moduleNode.children.find((child) => child.type === "dotted_name");
    spec = dotted ? dottedName(dotted) : "";
  } else if (moduleNode) {
    spec = moduleNode.type === "dotted_name" ? dottedName(moduleNode) : collapse(moduleNode.text);
  }
  const resolved = resolveModule(file, spec, level, "python");
  const span = spanFromTreeSitter(node.startPosition, node.endPosition);
  const names: Array<{ imported: string; local: string }> = [];
  let seenImport = false;
  for (const child of node.children) {
    if (!seenImport && child.type === "import") {
      seenImport = true;
      continue;
    }
    if (!seenImport) continue;
    if (child.type === "dotted_name" || child.type === "identifier") {
      const imported = child.type === "dotted_name" ? dottedName(child) : child.text;
      names.push({ imported, local: imported });
    } else if (child.type === "aliased_import") {
      const importedNode = child.childForFieldName("name");
      const alias = child.childForFieldName("alias");
      const imported = importedNode ? (importedNode.type === "dotted_name" ? dottedName(importedNode) : importedNode.text) : "";
      if (imported) names.push({ imported, local: alias?.text ?? imported });
    }
  }
  return names.map((entry) => ({ ...entry, spec, resolved, span }));
}

function pythonImport(node: SyntaxNode, file: string): ImportSite[] {
  const span = spanFromTreeSitter(node.startPosition, node.endPosition);
  const sites: ImportSite[] = [];
  for (const child of node.namedChildren) {
    const target = child.type === "aliased_import" ? child.childForFieldName("name") : child;
    const alias = child.type === "aliased_import" ? child.childForFieldName("alias") : null;
    if (!target) continue;
    const spec = target.type === "dotted_name" ? dottedName(target) : target.text;
    const local = alias?.text ?? spec.split(".").at(-1) ?? spec;
    sites.push({
      imported: local,
      local,
      spec,
      resolved: resolveModule(file, spec, 0, "python"),
      span,
    });
  }
  return sites;
}

function dottedName(node: SyntaxNode): string {
  const parts = node.children.filter((child) => child.type === "identifier").map((child) => child.text);
  return parts.length ? parts.join(".") : collapse(node.text);
}

function flat(node: SyntaxNode | null | undefined): string | undefined {
  if (!node) return undefined;
  const text = collapse(node.text).replace(/^:\s*/, "");
  return text || undefined;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function hasKeyword(node: SyntaxNode, keyword: string): boolean {
  return node.children.some((child) => child.text === keyword);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
