import { readFileSync } from "node:fs";

export function parseHeader(text: string): string {
  const lines = text.split("\n");
  const header = lines[0]?.trim() ?? "";
  if (header.length === 0) {
    throw new Error("missing header");
  }
  return header;
}

export function readFile(path: string): string {
  const text = readFileSync(path, "utf8");
  return parseHeader(text);
}
