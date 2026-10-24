import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cli = path.resolve("src/cli.ts");

function run(args: string[]) {
  return spawnSync("npx", ["tsx", cli, ...args], { encoding: "utf8" });
}

describe("cli", () => {
  it("prints the mixed TypeScript summary", () => {
    const result = run(["fixtures/typescript/mixed/before", "fixtures/typescript/mixed/after"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("renamed `foo` to `bar` (2 call sites and 1 import updated)");
    expect(result.stdout).toContain("extracted `parseHeader` from `readFile`");
  });

  it("exits 1 from --check when semantics changed and 0 for formatting", () => {
    const changed = run(["--check", "fixtures/python/rename/before", "fixtures/python/rename/after"]);
    expect(changed.status).toBe(1);
    const formatting = run(["--check", "fixtures/python/formatting/before", "fixtures/python/formatting/after"]);
    expect(formatting.status).toBe(0);
    expect(formatting.stdout).toContain("no semantic changes");
  });

  it("writes machine-readable JSON", () => {
    const result = run(["--format", "json", "--no-sources", "fixtures/python/inline/before", "fixtures/python/inline/after"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as { tool: string; operations: Array<{ kind: string }> };
    expect(report.tool).toBe("semantic-diff");
    expect(report.operations.map((operation) => operation.kind)).toEqual(["inline"]);
  });
});
