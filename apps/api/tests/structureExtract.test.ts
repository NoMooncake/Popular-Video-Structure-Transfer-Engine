import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";

import { app } from "../src/app.js";
import { validateSchema } from "../src/utils/schemaValidator.js";

let server: Server;
let baseUrl: string;

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

const postStructureExtract = async (body: unknown): Promise<Response> => {
  return fetch(`${baseUrl}/api/structure/extract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
};

test("POST /api/structure/extract returns fallback blueprint in mock mode", async () => {
  const response = await postStructureExtract({ use_mock: true });
  const body = (await response.json()) as {
    source: { type: string; model: string };
    slots: unknown[];
  };

  assert.equal(response.status, 200);
  assert.equal(body.source.type, "mock");
  assert.equal(body.source.model, "fallback_rule_engine");
  assert.ok(body.slots.length > 0);

  const validationResult = validateSchema("structure_blueprint", body);
  assert.equal(
    validationResult.valid,
    true,
    validationResult.valid
      ? undefined
      : JSON.stringify(validationResult.errors, null, 2)
  );
});

test("POST /api/structure/extract accepts sample analysis and returns slots", async () => {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const sampleAnalysis = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "examples/case_01/sample_analysis.mock.json"),
      "utf-8"
    )
  ) as unknown;

  const response = await postStructureExtract({
    sample_analysis: sampleAnalysis,
    vertical: "seeding_de_seeding",
    category: "pet_food"
  });
  const body = (await response.json()) as {
    sample_analysis_ref: string;
    category: string;
    slots: unknown[];
  };

  assert.equal(response.status, 200);
  assert.equal(body.sample_analysis_ref, "sample_analysis_case_01_mock");
  assert.equal(body.category, "pet_food");
  assert.ok(body.slots.length > 0);
});

test("POST /api/structure/extract accepts multiple sample analyses", async () => {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const firstSampleAnalysis = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "examples/case_01/sample_analysis.mock.json"),
      "utf-8"
    )
  ) as Record<string, unknown>;
  const secondSampleAnalysis = {
    ...firstSampleAnalysis,
    id: "sample_analysis_case_02_mock"
  };

  const response = await postStructureExtract({
    sample_analyses: [firstSampleAnalysis, secondSampleAnalysis],
    vertical: "seeding_de_seeding",
    category: "pet_food"
  });
  const body = (await response.json()) as {
    sample_analysis_ref: string;
    source: { ref_id: string };
    slots: Array<{ source_evidence: string[] }>;
  };

  assert.equal(response.status, 200);
  assert.equal(
    body.sample_analysis_ref,
    "sample_analysis_case_01_mock,sample_analysis_case_02_mock"
  );
  assert.equal(
    body.source.ref_id,
    "sample_analysis_case_01_mock,sample_analysis_case_02_mock"
  );
  assert.ok(body.slots.length > 0);
  assert.ok(
    body.slots[0]?.source_evidence.some((evidence) =>
      evidence.includes("sample_2_analysis: sample_analysis_case_02_mock")
    )
  );

  const validationResult = validateSchema("structure_blueprint", body);
  assert.equal(
    validationResult.valid,
    true,
    validationResult.valid
      ? undefined
      : JSON.stringify(validationResult.errors, null, 2)
  );
});

test("POST /api/structure/extract rejects missing input", async () => {
  const response = await postStructureExtract({});
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "invalid_structure_extract_input");
});
