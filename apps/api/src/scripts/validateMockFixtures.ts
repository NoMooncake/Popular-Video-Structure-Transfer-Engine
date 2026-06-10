import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateSchema } from "../utils/schemaValidator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../..");

const fixturePairs = [
  {
    schemaName: "sample_analysis",
    fixturePath: "examples/case_01/sample_analysis.mock.json"
  },
  {
    schemaName: "structure_blueprint",
    fixturePath: "examples/case_01/structure_blueprint.mock.json"
  },
  {
    schemaName: "material_analysis",
    fixturePath: "examples/case_01/material_analysis.mock.json"
  },
  {
    schemaName: "gap_report",
    fixturePath: "examples/case_01/gap_report.mock.json"
  },
  {
    schemaName: "timeline_plan",
    fixturePath: "examples/case_01/timeline_plan.mock.json"
  }
] as const;

let hasFailure = false;

for (const fixturePair of fixturePairs) {
  const absoluteFixturePath = path.join(repoRoot, fixturePair.fixturePath);
  const fixture = JSON.parse(fs.readFileSync(absoluteFixturePath, "utf-8")) as unknown;
  const result = validateSchema(fixturePair.schemaName, fixture);

  if (!result.valid) {
    hasFailure = true;
    console.error(`failed ${fixturePair.fixturePath}`);
    console.error(JSON.stringify(result.errors, null, 2));
    continue;
  }

  console.log(`ok ${fixturePair.fixturePath}`);
}

if (hasFailure) {
  process.exit(1);
}
