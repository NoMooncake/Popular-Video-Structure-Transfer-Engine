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

const postJson = async (routePath: string, body: unknown): Promise<Response> => {
  return fetch(`${baseUrl}${routePath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
};

const createTimelineInputs = async (): Promise<{
  structureBlueprint: unknown;
  slotMapping: unknown;
  gapReport: unknown;
  fillStrategies: unknown;
}> => {
  const structureBlueprint = readCaseFixture("structure_blueprint.mock.json");
  const materialAnalysis = readCaseFixture("material_analysis.mock.json");

  const migrationResponse = await postJson("/api/structure/migrate", {
    structure_blueprint: structureBlueprint,
    material_analysis: materialAnalysis,
    target_topic: "猫粮避坑种草",
    selling_points: ["单一肉源", "低油配方"]
  });
  const slotMapping = await migrationResponse.json();

  assert.equal(migrationResponse.status, 200);

  const gapResponse = await postJson("/api/gap/detect", {
    slot_mapping: slotMapping,
    confidence_threshold: 0.99
  });
  const gapReport = await gapResponse.json();

  assert.equal(gapResponse.status, 200);

  const fillResponse = await postJson("/api/gap/fill-strategy", {
    gap_report: gapReport,
    target_topic: "猫粮避坑种草"
  });
  const fillStrategies = await fillResponse.json();

  assert.equal(fillResponse.status, 200);

  return {
    structureBlueprint,
    slotMapping,
    gapReport,
    fillStrategies
  };
};

test("POST /api/generate/timeline creates a schema-valid frontend timeline", async () => {
  const { structureBlueprint, slotMapping, gapReport, fillStrategies } =
    await createTimelineInputs();

  const response = await postJson("/api/generate/timeline", {
    structure_blueprint: structureBlueprint,
    slot_mapping: slotMapping,
    gap_report: gapReport,
    fill_strategies: fillStrategies
  });
  const body = (await response.json()) as {
    target_video: {
      duration_seconds: number;
    };
    script: {
      full_text: string;
    };
    timeline: Array<{
      slot_id: string;
      slot_type: string;
      time_range: {
        start_seconds?: number;
        end_seconds?: number;
      };
      visual_source: string;
      subtitle: string;
      voiceover: string;
      packaging: unknown[];
      material_ref?: string | string[];
      gap_ref?: string | string[];
      fill_strategy_ref?: string | string[];
    }>;
  };

  assert.equal(response.status, 200);
  assert.ok(body.target_video.duration_seconds >= 15);
  assert.ok(body.target_video.duration_seconds <= 30);
  assert.ok(body.script.full_text.length > 0);
  assert.ok(body.timeline.length > 0);
  assert.ok(
    body.timeline.every(
      (item) =>
        item.slot_id &&
        item.slot_type &&
        item.visual_source &&
        item.subtitle &&
        item.voiceover &&
        item.packaging.length > 0
    )
  );
  assert.ok(body.timeline.some((item) => Boolean(item.material_ref)));
  assert.ok(body.timeline.some((item) => Boolean(item.gap_ref)));
  assert.ok(body.timeline.some((item) => Boolean(item.fill_strategy_ref)));
  assert.ok(
    body.timeline.every(
      (item) =>
        typeof item.time_range.start_seconds === "number" &&
        typeof item.time_range.end_seconds === "number" &&
        item.time_range.start_seconds >= 0 &&
        item.time_range.end_seconds > item.time_range.start_seconds &&
        item.time_range.end_seconds <= body.target_video.duration_seconds
    )
  );

  const validationResult = validateSchema("timeline_plan", body);
  assert.equal(
    validationResult.valid,
    true,
    validationResult.valid
      ? undefined
      : JSON.stringify(validationResult.errors, null, 2)
  );
});

test("POST /api/generate/timeline rejects missing slot mapping", async () => {
  const response = await postJson("/api/generate/timeline", {});
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "invalid_timeline_generate_input");
});
