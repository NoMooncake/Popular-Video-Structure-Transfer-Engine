import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { validateSchema, type SchemaName } from "../src/utils/schemaValidator.js";

const repoRoot = path.resolve(process.cwd(), "../..");
const caseDir = path.join(repoRoot, "examples/case_01");

const fixtures: Array<{ schemaName: SchemaName; filename: string }> = [
  { schemaName: "sample_analysis", filename: "sample_analysis.mock.json" },
  { schemaName: "structure_blueprint", filename: "structure_blueprint.mock.json" },
  { schemaName: "material_analysis", filename: "material_analysis.mock.json" },
  { schemaName: "gap_report", filename: "gap_report.mock.json" },
  { schemaName: "timeline_plan", filename: "timeline_plan.mock.json" }
];

for (const fixture of fixtures) {
  test(`${fixture.filename} passes ${fixture.schemaName} schema`, () => {
    const fixturePath = path.join(caseDir, fixture.filename);
    const data = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as unknown;
    const result = validateSchema(fixture.schemaName, data);

    assert.equal(
      result.valid,
      true,
      result.valid ? undefined : JSON.stringify(result.errors, null, 2)
    );
  });
}
