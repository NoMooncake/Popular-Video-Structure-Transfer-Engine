import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";

import { app } from "../src/app.js";
import { validateSchema } from "../src/utils/schemaValidator.js";

let server: Server;
let baseUrl: string;

const repoRoot = path.resolve(process.cwd(), "../..");
const caseDir = path.join(repoRoot, "examples/case_01");

const getServerPort = (httpServer: Server): number => {
  const address = httpServer.address();

  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }

  return address.port;
};

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });

  baseUrl = `http://127.0.0.1:${getServerPort(server)}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
});

const readCaseFixture = (filename: string): unknown => {
  return JSON.parse(
    fs.readFileSync(path.join(caseDir, filename), "utf-8")
  ) as unknown;
};

const postJson = async (path: string, body: unknown): Promise<Response> => {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
};

const createSlotMapping = async (): Promise<{
  id: string;
  mappings: Array<{
    slot_type: string;
    material_status: string;
    match_confidence: number;
    missing_material: boolean;
    missing_reasons: string[];
    matched_material_refs: string[];
  }>;
}> => {
  const migrationResponse = await postJson("/api/structure/migrate", {
    structure_blueprint: readCaseFixture("structure_blueprint.mock.json"),
    material_analysis: readCaseFixture("material_analysis.mock.json"),
    target_topic: "猫粮避坑种草",
    selling_points: ["单一肉源", "低油配方"]
  });

  assert.equal(migrationResponse.status, 200);
  return (await migrationResponse.json()) as {
    id: string;
    mappings: Array<{
      slot_type: string;
      material_status: string;
      match_confidence: number;
      missing_material: boolean;
      missing_reasons: string[];
      matched_material_refs: string[];
    }>;
  };
};

const weakenSlotMapping = async (): Promise<unknown> => {
  const slotMapping = await createSlotMapping();

  for (const mapping of slotMapping.mappings) {
    if (mapping.slot_type === "risk_or_pain_hook") {
      mapping.material_status = "missing";
      mapping.missing_material = true;
      mapping.match_confidence = 0.18;
      mapping.missing_reasons = ["缺少强风险开头画面。"];
      mapping.matched_material_refs = [];
    }

    if (mapping.slot_type === "proof_comparison") {
      mapping.material_status = "partial";
      mapping.missing_material = true;
      mapping.match_confidence = 0.46;
      mapping.missing_reasons = ["缺少横向对比或证明画面。"];
    }

    if (mapping.slot_type === "cta") {
      mapping.material_status = "partial";
      mapping.missing_material = true;
      mapping.match_confidence = 0.52;
      mapping.missing_reasons = ["缺少结尾 CTA 专用画面。"];
    }
  }

  return slotMapping;
};

test("POST /api/gap/detect returns schema-valid gap report", async () => {
  const slotMapping = await weakenSlotMapping();
  const response = await postJson("/api/gap/detect", {
    slot_mapping: slotMapping
  });
  const body = (await response.json()) as {
    gaps: Array<{
      missing: string;
      impact: string;
      strategy: string;
      fill_options?: unknown[];
    }>;
    summary: { total_gaps: number };
  };

  assert.equal(response.status, 200);
  assert.ok(body.summary.total_gaps >= 2);
  assert.ok(body.gaps.some((gap) => gap.missing.includes("开头吸引")));
  assert.ok(body.gaps.some((gap) => gap.missing.includes("对比")));
  assert.ok(body.gaps.every((gap) => gap.impact.length > 0));
  assert.ok(body.gaps.every((gap) => gap.strategy.length > 0));
  assert.ok(body.gaps.every((gap) => (gap.fill_options || []).length > 0));

  const validationResult = validateSchema("gap_report", body);
  assert.equal(
    validationResult.valid,
    true,
    validationResult.valid
      ? undefined
      : JSON.stringify(validationResult.errors, null, 2)
  );
});

test("POST /api/gap/detect returns empty report when mapping is sufficient", async () => {
  const slotMapping = await createSlotMapping();
  const response = await postJson("/api/gap/detect", {
    slot_mapping: slotMapping,
    confidence_threshold: 0.1
  });
  const body = (await response.json()) as {
    summary: { overall_status: string; total_gaps: number };
    gaps: unknown[];
  };

  assert.equal(response.status, 200);
  assert.equal(body.summary.overall_status, "sufficient");
  assert.equal(body.summary.total_gaps, 0);
  assert.equal(body.gaps.length, 0);
});

test("POST /api/gap/detect rejects missing input", async () => {
  const response = await postJson("/api/gap/detect", {});
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "invalid_gap_detect_input");
});
