import assert from "node:assert/strict";
import type { Server } from "node:http";
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

const postJson = async (path: string, body: unknown): Promise<Response> => {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
};

test("POST /api/material/analyze accepts raw material input fields", async () => {
  const response = await postJson("/api/material/analyze", {
    target_topic: "猫粮避坑种草",
    target_audience: "新手养猫用户",
    product_name: "低敏猫粮",
    selling_points: [
      "单一肉源，降低过敏风险",
      "低油配方，减少黑下巴风险"
    ],
    uploaded_file_ids: ["test-video-file-id"],
    text_assets: [
      {
        type: "note",
        content: "家里猫咪玻璃胃，换粮需要循序渐进。"
      }
    ]
  });
  const body = (await response.json()) as {
    materials: unknown[];
    segments: unknown[];
    coverage_summary: { supported_slot_types: string[] };
  };

  assert.equal(response.status, 200);
  assert.ok(body.materials.length >= 3);
  assert.ok(body.segments.length >= 3);
  assert.ok(body.coverage_summary.supported_slot_types.includes("product_reveal"));

  const validationResult = validateSchema("material_analysis", body);
  assert.equal(
    validationResult.valid,
    true,
    validationResult.valid
      ? undefined
      : JSON.stringify(validationResult.errors, null, 2)
  );
});

test("POST /api/material/analyze accepts material_input object", async () => {
  const inputResponse = await postJson("/api/material/input", {
    target_topic: "大衣种草测评",
    selling_points: ["显高显瘦", "适合通勤"]
  });
  const materialInput = (await inputResponse.json()) as unknown;

  const analyzeResponse = await postJson("/api/material/analyze", {
    material_input: materialInput
  });
  const body = (await analyzeResponse.json()) as {
    source: { material_input_ref: string };
  };

  assert.equal(inputResponse.status, 201);
  assert.equal(analyzeResponse.status, 200);
  assert.equal(
    body.source.material_input_ref,
    (materialInput as { id: string }).id
  );
});

test("POST /api/material/analyze rejects invalid input", async () => {
  const response = await postJson("/api/material/analyze", {
    target_topic: "只有主题，没有卖点"
  });
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "invalid_material_analysis_input");
});
