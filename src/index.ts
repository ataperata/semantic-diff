import { analyzeSnapshots } from "./analyze.js";
import { loadPath } from "./load.js";
import type { AnalyzeOptions, Report, Snapshot } from "./types.js";

export { analyzeSnapshots } from "./analyze.js";
export { VERSION } from "./version.js";
export type {
  AnalyzeOptions,
  AstEdit,
  FileEntry,
  Highlight,
  Operation,
  Report,
  Snapshot,
  SourceFile,
  SymbolRef,
} from "./types.js";

export function analyzePaths(left: string, right: string, options: AnalyzeOptions = {}): Report {
  const leftSnapshot = loadPath(left, options.leftLabel ?? left);
  const rightSnapshot = loadPath(right, options.rightLabel ?? right);
  if (sameBasename(left, right) && leftSnapshot.files.length === 1 && rightSnapshot.files.length === 1) {
    const name = leftSnapshot.files[0]?.path ?? rightSnapshot.files[0]?.path ?? "file";
    const normalizedLeft: Snapshot = {
      label: leftSnapshot.label,
      files: leftSnapshot.files.map((file) => ({ ...file, path: name })),
    };
    const normalizedRight: Snapshot = {
      label: rightSnapshot.label,
      files: rightSnapshot.files.map((file) => ({ ...file, path: name })),
    };
    return analyzeSnapshots(normalizedLeft, normalizedRight, options);
  }
  return analyzeSnapshots(leftSnapshot, rightSnapshot, options);
}

function sameBasename(left: string, right: string): boolean {
  if (left === "/dev/null" || right === "/dev/null") return false;
  return fileName(left) === fileName(right);
}

function fileName(target: string): string {
  const parts = target.split(/[\\/]/);
  return parts[parts.length - 1] ?? target;
}
