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

const postPipeline = async (body: unknown): Promise<Response> => {
  return fetch(`${baseUrl}/api/pipeline/p0`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
};

test("POST /api/pipeline/p0 returns every P0 stage result", async () => {
  const response = await postPipeline({
    sample_analysis: readCaseFixture("sample_analysis.mock.json"),
    material_input: {
      target_topic: "猫粮避坑种草",
      target_audience: "新手养猫用户",
      product_name: "低敏猫粮",
      selling_points: ["单一肉源", "低油配方", "小包装试吃"],
      uploaded_file_ids: ["user_video_clip_01.mp4", "product_closeup_01.jpg"],
      text_assets: [
        {
          type: "copy",
          content: "适合肠胃敏感、容易挑食的猫咪。"
        }
      ]
    },
    use_mock: true,
    confidence_threshold: 0.99
  });
  const body = (await response.json()) as {
    summary: {
      status: string;
      stage_count: number;
      total_slots: number;
      total_gaps: number;
      timeline_item_count: number;
    };
    stages: {
      sample_analysis: unknown;
      structure_blueprint: unknown;
      material_input: unknown;
      material_analysis: unknown;
      slot_mapping: unknown;
      gap_report: unknown;
      fill_strategies: unknown;
      timeline_plan: {
        timeline: unknown[];
      };
    };
  };

  assert.equal(response.status, 200);
  assert.equal(body.summary.status, "completed");
  assert.equal(body.summary.stage_count, 8);
  assert.ok(body.summary.total_slots > 0);
  assert.ok(body.summary.total_gaps > 0);
  assert.equal(
    body.summary.timeline_item_count,
    body.stages.timeline_plan.timeline.length
  );

  assert.equal(validateSchema("sample_analysis", body.stages.sample_analysis).valid, true);
  assert.equal(
    validateSchema("structure_blueprint", body.stages.structure_blueprint).valid,
    true
  );
  assert.equal(
    validateSchema("material_analysis", body.stages.material_analysis).valid,
    true
  );
  assert.equal(validateSchema("slot_mapping", body.stages.slot_mapping).valid, true);
  assert.equal(validateSchema("gap_report", body.stages.gap_report).valid, true);
  assert.equal(validateSchema("gap_report", body.stages.fill_strategies).valid, true);
  assert.equal(
    validateSchema("timeline_plan", body.stages.timeline_plan).valid,
    true
  );
});

test("POST /api/pipeline/p0 returns failed stage when a stage fails", async () => {
  const response = await postPipeline({
    material_input: {
      target_topic: "猫粮避坑种草",
      selling_points: ["单一肉源"]
    }
  });
  const body = (await response.json()) as {
    error: {
      code: string;
      stage: string;
      message: string;
    };
  };

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "pipeline_stage_failed");
  assert.equal(body.error.stage, "sample_analyze");
  assert.match(body.error.message, /sample_file_id or sample_analysis/u);
});
