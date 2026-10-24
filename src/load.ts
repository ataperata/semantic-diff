import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { grammarOf } from "./parse/extract.js";
import type { Snapshot, SourceFile } from "./types.js";

const IGNORE = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  "target",
  ".semantic-diff-tmp",
]);

const MAX_FILE_BYTES = 1_000_000;

export function loadDirectory(directory: string, label = directory): Snapshot {
  const root = path.resolve(directory);
  const files: SourceFile[] = [];
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (!grammarOf(relative)) continue;
      const info = statSync(full);
      if (info.size > MAX_FILE_BYTES) continue;
      const text = readFileSync(full, "utf8");
      if (text.includes("\0")) continue;
      files.push({ path: relative, text });
    }
  };
  walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { label, files };
}

export function loadPath(target: string, label?: string): Snapshot {
  if (target === "/dev/null" || !exists(target)) return { label: label ?? target, files: [] };
  const info = statSync(target);
  if (info.isDirectory()) return loadDirectory(target, label ?? target);
  const relative = path.basename(target);
  if (!grammarOf(relative)) {
    return { label: label ?? target, files: [{ path: relative, text: readFileSync(target, "utf8") }] };
  }
  return { label: label ?? target, files: [{ path: relative, text: readFileSync(target, "utf8") }] };
}

export function materializeGitRef(ref: string, repo: string): { snapshot: Snapshot; cleanup: () => void } {
  const directory = mkdtempSync(path.join(tmpdir(), "semantic-diff-"));
  try {
    const archive = execFileSync("git", ["archive", "--format=tar", ref], {
      cwd: repo,
      maxBuffer: 64 * 1024 * 1024,
    });
    execFileSync("tar", ["-x", "-C", directory], { input: archive, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read git ref '${ref}' in ${repo}. ${message}`);
  }
  return {
    snapshot: loadDirectory(directory, ref),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function exists(target: string): boolean {
  try {
    statSync(target);
    return true;
  } catch {
    return false;
  }
}
