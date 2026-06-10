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

const createGapReport = async (): Promise<unknown> => {
  const migrationResponse = await postJson("/api/structure/migrate", {
    structure_blueprint: readCaseFixture("structure_blueprint.mock.json"),
    material_analysis: readCaseFixture("material_analysis.mock.json"),
    target_topic: "猫粮避坑种草",
    selling_points: ["单一肉源", "低油配方"]
  });
  const slotMapping = await migrationResponse.json();

  assert.equal(migrationResponse.status, 200);

  const gapResponse = await postJson("/api/gap/detect", {
    slot_mapping: slotMapping,
    confidence_threshold: 0.99
  });

  assert.equal(gapResponse.status, 200);
  return gapResponse.json();
};

test("POST /api/gap/fill-strategy enriches every gap with strategies", async () => {
  const gapReport = await createGapReport();
  const response = await postJson("/api/gap/fill-strategy", {
    gap_report: gapReport,
    target_topic: "猫粮避坑种草"
  });
  const body = (await response.json()) as {
    gaps: Array<{
      fill_options: Array<{
        type: string;
        reason?: string;
        prompt?: string;
        requires_aigc?: boolean;
      }>;
    }>;
  };

  assert.equal(response.status, 200);
  assert.ok(body.gaps.length > 0);
  assert.ok(body.gaps.every((gap) => gap.fill_options.length >= 1));
  assert.ok(
    body.gaps.every((gap) =>
      gap.fill_options.every((option) => option.reason && option.reason.length > 0)
    )
  );
  assert.ok(
    body.gaps.some((gap) =>
      gap.fill_options.some((option) => option.type === "text_overlay_fill")
    )
  );
  assert.ok(
    body.gaps.some((gap) =>
      gap.fill_options.some((option) => option.type === "packaging_card_fill")
    )
  );
  assert.ok(
    body.gaps.some((gap) =>
      gap.fill_options.some((option) => option.type === "reuse_existing_material")
    )
  );
  assert.ok(
    body.gaps.some((gap) =>
      gap.fill_options.some(
        (option) => option.type === "aigc_prompt_candidate"
      )
    )
  );

  const aigcPrompts = body.gaps.flatMap((gap) =>
    gap.fill_options
      .filter((option) => option.requires_aigc)
      .map((option) => option.prompt || "")
  );

  assert.ok(aigcPrompts.length > 0);
  assert.ok(aigcPrompts.every((prompt) => prompt.includes("不引用、不复刻")));

  const validationResult = validateSchema("gap_report", body);
  assert.equal(
    validationResult.valid,
    true,
    validationResult.valid
      ? undefined
      : JSON.stringify(validationResult.errors, null, 2)
  );
});

test("POST /api/gap/fill-strategy rejects missing input", async () => {
  const response = await postJson("/api/gap/fill-strategy", {});
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "invalid_gap_fill_strategy_input");
});
