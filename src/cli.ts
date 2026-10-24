#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePaths, analyzeSnapshots, VERSION } from "./index.js";
import { materializeGitRef } from "./load.js";
import { formatReportText } from "./summary.js";
import type { Report } from "./types.js";

interface Flags {
  format: "text" | "json" | "both";
  out?: string;
  sources: boolean;
  check: boolean;
  verbose: boolean;
  repo: string;
  port: number;
  help: boolean;
}

const HELP = `semantic-diff ${VERSION}
AST-aware diffs for TypeScript and Python.

Usage
  semantic-diff <left> <right> [--format text|json|both] [-o report.json]
  semantic-diff git <ref1> <ref2> [--repo path]
  semantic-diff difftool <local> <remote>
  semantic-diff view [report.json] [--port 4173]

Options
  --format <text|json|both>   Human summary, JSON report, or both (default text)
  -o, --out <file>            Write the JSON report to a file
  --no-sources                Omit file text from the JSON report
  --check                     Exit 1 when a semantic change is found
  --verbose                   Print AST edit snippets under the summary
  --repo <path>               Repository for \`git\` (default: current directory)
  --port <n>                  Viewer port (default 4173)
  -h, --help                  Show this help

Git difftool
  git config diff.tool semantic-diff
  git config difftool.semantic-diff.cmd 'semantic-diff difftool "$LOCAL" "$REMOTE"'
  git config difftool.prompt false
  git difftool -d HEAD~1 HEAD

A pure formatting change is ignored. Renames, moves, extracts, inlines,
signature changes, reorders, and leftover logic edits are reported.
`;

const COMMANDS = new Set(["git", "diff", "difftool", "view", "help"]);

function main(argv: string[]): void {
  const { command, positionals, flags } = parseCli(argv);
  if (flags.help || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "view") {
    serveViewer(positionals[0], flags.port);
    return;
  }
  const report = runCommand(command, positionals, flags);
  emit(report, flags);
}

function runCommand(command: string, positionals: string[], flags: Flags): Report {
  if (command === "git") {
    const [left, right] = positionals;
    if (!left || !right) usage("git requires two refs");
    const before = materializeGitRef(left, flags.repo);
    const after = materializeGitRef(right, flags.repo);
    try {
      return analyzeSnapshots(before.snapshot, after.snapshot, {
        embedSources: flags.sources,
        leftLabel: left,
        rightLabel: right,
      });
    } finally {
      before.cleanup();
      after.cleanup();
    }
  }
  const [left, right] = positionals;
  if (!left || !right) usage("provide two directories, files, or git refs");
  return analyzePaths(left, right, { embedSources: flags.sources, leftLabel: left, rightLabel: right });
}

function emit(report: Report, flags: Flags): void {
  const json = JSON.stringify(report, null, 2) + "\n";
  if (flags.out) writeFileSync(flags.out, json);
  if (flags.format === "json") process.stdout.write(json);
  else if (flags.format === "both") {
    process.stdout.write(json);
    process.stderr.write(textOf(report, flags.verbose));
  } else process.stdout.write(textOf(report, flags.verbose));
  if (flags.check && report.stats.operations > 0) process.exitCode = 1;
}

function textOf(report: Report, verbose: boolean): string {
  const stats = `${report.stats.operations} semantic operation${report.stats.operations === 1 ? "" : "s"} · ${report.stats.filesCompared} file${report.stats.filesCompared === 1 ? "" : "s"} compared · ${report.stats.formattingOnlyFiles} formatting-only`;
  return formatReportText(report.summaryLines, stats, report.operations, verbose);
}

function serveViewer(reportPath: string | undefined, port: number): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "../viewer");
  if (!existsSync(root)) throw new Error(`Viewer assets not found at ${root}`);
  const report = reportPath ? JSON.parse(readFileSync(reportPath, "utf8")) as unknown : null;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/report.json") {
      if (!report) {
        send(response, 404, "application/json", JSON.stringify({ error: "no report was passed to view" }));
        return;
      }
      send(response, 200, "application/json", JSON.stringify(report));
      return;
    }
    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = safeJoin(root, relative);
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      send(response, 404, "text/plain", "not found");
      return;
    }
    response.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
    createReadStream(file).pipe(response);
  });
  server.listen(port, "127.0.0.1", () => {
    const address = `http://127.0.0.1:${port}`;
    process.stdout.write(`semantic-diff viewer ${address}\n`);
    if (process.env.SEMANTIC_DIFF_OPEN === "1") {
      execFile("xdg-open", [address], () => undefined);
    }
  });
}

function safeJoin(root: string, requestPath: string): string | null {
  const resolved = path.resolve(root, `.${requestPath}`);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(prefix)) return null;
  return resolved;
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { "content-type": type });
  response.end(body);
}

function parseCli(argv: string[]): { command: string; positionals: string[]; flags: Flags } {
  const flags: Flags = {
    format: "text",
    sources: true,
    check: false,
    verbose: false,
    repo: process.cwd(),
    port: 4173,
    help: false,
  };
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--check") flags.check = true;
    else if (arg === "--verbose") flags.verbose = true;
    else if (arg === "--no-sources") flags.sources = false;
    else if (arg === "--format") flags.format = readFormat(argv[++index]);
    else if (arg === "--out" || arg === "-o") flags.out = required(argv[++index], arg);
    else if (arg === "--repo") flags.repo = required(argv[++index], arg);
    else if (arg === "--port") flags.port = Number(required(argv[++index], arg));
    else if (arg.startsWith("-")) usage(`unknown option ${arg}`);
    else positionals.push(arg);
  }
  const head = positionals[0] ?? "";
  if (COMMANDS.has(head)) return { command: head, positionals: positionals.slice(1), flags };
  return { command: "diff", positionals, flags };
}

function readFormat(value: string | undefined): Flags["format"] {
  if (value === "text" || value === "json" || value === "both") return value;
  usage("--format must be text, json, or both");
}

function required(value: string | undefined, flag: string): string {
  if (!value) usage(`${flag} needs a value`);
  return value;
}

function usage(message: string): never {
  process.stderr.write(`semantic-diff: ${message}\n\n${HELP}`);
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
