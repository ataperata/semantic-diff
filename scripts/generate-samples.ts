import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { analyzePaths } from "../src/index.js";

const fixtureRoot = path.resolve("fixtures");
const outDir = path.resolve("viewer/samples");
mkdirSync(outDir, { recursive: true });

interface SampleIndexEntry {
  id: string;
  title: string;
  language: string;
  file: string;
  summary: string;
}

const index: SampleIndexEntry[] = [];
for (const language of ["typescript", "python"]) {
  for (const name of readdirSync(path.join(fixtureRoot, language)).sort()) {
    const dir = path.join(fixtureRoot, language, name);
    const expected = JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf8")) as { title?: string };
    const report = analyzePaths(path.join(dir, "before"), path.join(dir, "after"), {
      embedSources: true,
      leftLabel: `fixtures/${language}/${name}/before`,
      rightLabel: `fixtures/${language}/${name}/after`,
    });
    const file = `${language}__${name}.json`;
    writeFileSync(path.join(outDir, file), JSON.stringify(report, null, 2) + "\n");
    index.push({
      id: `${language}/${name}`,
      title: expected.title ?? `${language} ${name}`,
      language,
      file,
      summary: report.summary,
    });
  }
}

writeFileSync(path.join(outDir, "index.json"), JSON.stringify(index, null, 2) + "\n");
process.stdout.write(`wrote ${index.length} samples to ${outDir}\n`);
