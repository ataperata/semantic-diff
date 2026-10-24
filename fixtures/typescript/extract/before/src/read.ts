import { readFileSync } from "node:fs";

export function readFile(path: string): string {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const header = lines[0]?.trim() ?? "";
  if (header.length === 0) {
    throw new Error("missing header");
  }
  return header;
}
