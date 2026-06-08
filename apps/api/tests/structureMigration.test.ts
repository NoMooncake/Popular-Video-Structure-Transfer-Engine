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

const postMigration = async (body: unknown): Promise<Response> => {
  return fetch(`${baseUrl}/api/structure/migrate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
};

test("POST /api/structure/migrate maps every structure slot", async () => {
  const structureBlueprint = readCaseFixture("structure_blueprint.mock.json") as {
    slots: unknown[];
  };
  const materialAnalysis = readCaseFixture("material_analysis.mock.json");

  const response = await postMigration({
    structure_blueprint: structureBlueprint,
    material_analysis: materialAnalysis,
    target_topic: "猫粮避坑种草",
    selling_points: ["单一肉源", "低油配方"]
  });
  const body = (await response.json()) as {
    mappings: Array<{
      slot_id: string;
      material_status: string;
      missing_material: boolean;
    }>;
    summary: {
      total_slots: number;
      ready_for_gap_detection: boolean;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(body.mappings.length, structureBlueprint.slots.length);
  assert.equal(body.summary.total_slots, structureBlueprint.slots.length);
  assert.equal(body.summary.ready_for_gap_detection, true);
  assert.ok(
    body.mappings.every((mapping) =>
      ["matched", "partial", "missing"].includes(mapping.material_status)
    )
  );

  const validationResult = validateSchema("slot_mapping", body);
  assert.equal(
    validationResult.valid,
    true,
    validationResult.valid
      ? undefined
      : JSON.stringify(validationResult.errors, null, 2)
  );
});

test("POST /api/structure/migrate rejects missing inputs", async () => {
  const response = await postMigration({});
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "invalid_structure_migration_input");
});
