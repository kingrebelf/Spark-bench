// Regenerates examples/*.sbproj from src/library/examples.ts.  Run:  npx tsx examples/build.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import "../src/library";
import { buildExamples, exampleText } from "../src/library/examples";

for (const e of buildExamples()) {
  const file = join(__dirname, `${e.file}.sbproj`);
  writeFileSync(file, exampleText(e));
  console.log(`wrote ${file}`);
}
