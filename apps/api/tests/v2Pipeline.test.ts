import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";

import { app } from "../src/app.js";
import { storageConfig } from "../src/config/storage.js";
import { buildV2DeterministicMaterialCoverage } from "../src/services/v2PipelineService.js";
import type { V2PipelineRequest } from "../src/v2/types.js";

let server: Server;
let baseUrl: string;

const generatedFileIds: string[] = [];

const getServerPort = (httpServer: Server): number => {
  const address = httpServer.address();

  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }

  return address.port;
};

const hasFFmpegAndFFprobe = (): boolean => {
  return (
    spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 &&
    spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0
  );
};

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });

  baseUrl = `http://127.0.0.1:${getServerPort(server)}`;
});

after(async () => {
  fs.mkdirSync(storageConfig.uploadDir, { recursive: true });

  for (const fileId of generatedFileIds) {
    const uploadedFiles = fs
      .readdirSync(storageConfig.uploadDir)
      .filter((filename) => filename.startsWith(`${fileId}-`));

    for (const filename of uploadedFiles) {
      fs.rmSync(path.join(storageConfig.uploadDir, filename), { force: true });
    }
  }

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

const createUploadedTestVideo = (durationSeconds: number): string => {
  fs.mkdirSync(storageConfig.uploadDir, { recursive: true });
  const fileId = crypto.randomUUID();
  const videoPath = path.join(storageConfig.uploadDir, `${fileId}-sample.mp4`);

  execFileSync(
    "ffmpeg",
    [
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=360x640:rate=12:duration=${durationSeconds}`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      videoPath
    ],
    { stdio: "ignore" }
  );

  generatedFileIds.push(fileId);
  return fileId;
};

test(
  "v2 deterministic material coverage blocks short material from covering longer target",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    const fileId = createUploadedTestVideo(5);
    const normalized = {
      reference_videos: [],
      reference_file_ids: [],
      user_materials: [
        {
          file_id: fileId,
          uri: `/api/upload/files/${fileId}`,
          role: "user_material" as const
        }
      ],
      user_material_file_ids: [],
      text_assets: [],
      user_request: {
        goal: "生成 18 秒广告"
      },
      options: {
        image_candidate_count: 4,
        generate_image_candidates: false,
        target_duration_seconds: 18,
        allow_fallback: true
      }
    } satisfies Required<V2PipelineRequest>;

    const coverage = await buildV2DeterministicMaterialCoverage(
      normalized,
      {
        slots: [
          {
            slot_id: "slot_01",
            slot_type: "strong_hook",
            time_range: {
              start_seconds: 0,
              end_seconds: 9
            }
          },
          {
            slot_id: "slot_02",
            slot_type: "product_hero",
            time_range: {
              start_seconds: 9,
              end_seconds: 18
            }
          }
        ]
      },
      {
        usable_materials: [
          {
            material_id: "user_material_01",
            file_id: fileId,
            usable_for_slots: ["strong_hook", "product_hero"],
            inferred_type: "product_demo_video"
          }
        ],
        coverage_by_slot_type: [
          {
            slot_type: "strong_hook",
            material_refs: ["user_material_01"]
          },
          {
            slot_type: "product_hero",
            material_refs: ["user_material_01"]
          }
        ]
      }
    );

    assert.equal(coverage.materials_sufficient, false);
    assert.equal(coverage.requires_ai_completion, true);
    assert.equal(coverage.total_known_material_duration_seconds, 5);
    assert.equal(coverage.hard_constraints.total_duration_coverage_passed, false);
    assert.deepEqual(coverage.material_assets[0]?.frame_sample_timestamps_seconds, [
      0.75,
      2.5,
      4.25
    ]);
    assert.equal(coverage.slot_coverage[0]?.coverage_status, "partial");
    assert.equal(coverage.slot_coverage[0]?.matched_material_duration, 5);
    assert.equal(coverage.slot_coverage[1]?.coverage_status, "missing");
    assert.equal(coverage.slot_coverage[1]?.matched_material_duration, 0);
  }
);

test("GET /api/v2/status exposes 4 as the default image candidate count", async () => {
  const response = await fetch(`${baseUrl}/api/v2/status`);
  const body = (await response.json()) as {
    image_candidate_count_default: number;
    image_candidate_count_max: number;
  };

  assert.equal(response.status, 200);
  assert.equal(body.image_candidate_count_default, 4);
  assert.equal(body.image_candidate_count_max, 6);
});
