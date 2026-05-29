import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";

import { app } from "../src/app.js";
import { storageConfig } from "../src/config/storage.js";
import { validateSchema } from "../src/utils/schemaValidator.js";

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

const hasFFmpeg = (): boolean => {
  const result = spawnSync("ffmpeg", ["-version"], {
    stdio: "ignore"
  });

  return result.status === 0;
};

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });

  baseUrl = `http://127.0.0.1:${getServerPort(server)}`;
});

after(async () => {
  for (const fileId of generatedFileIds) {
    fs.rmSync(path.join(storageConfig.outputDir, "frames", fileId), {
      force: true,
      recursive: true
    });

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

const createUploadedTestVideo = (): string => {
  fs.mkdirSync(storageConfig.uploadDir, { recursive: true });
  const fileId = crypto.randomUUID();
  const videoPath = path.join(storageConfig.uploadDir, `${fileId}-sample.mp4`);

  execFileSync(
    "ffmpeg",
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=360x640:rate=12:duration=2",
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
  "POST /api/sample/analyze returns schema-valid sample analysis",
  { skip: hasFFmpeg() ? false : "ffmpeg is required to generate test video" },
  async () => {
    const fileId = createUploadedTestVideo();
    const response = await fetch(`${baseUrl}/api/sample/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ file_id: fileId })
    });
    const body = (await response.json()) as {
      id: string;
      video: {
        resolution: string;
        cover_frame: { uri: string };
      };
      shot_count: number;
      keyframes: unknown[];
      transcript: { status: string; summary: string };
    };

    assert.equal(response.status, 200);
    assert.equal(body.video.resolution, "360x640");
    assert.ok(body.video.cover_frame.uri.startsWith(`/api/frames/${fileId}/`));
    assert.ok(body.keyframes.length >= 3);
    assert.equal(body.shot_count, body.keyframes.length);
    assert.equal(body.transcript.status, "not_started");
    assert.ok(body.transcript.summary.length > 0);

    const validationResult = validateSchema("sample_analysis", body);
    assert.equal(
      validationResult.valid,
      true,
      validationResult.valid
        ? undefined
        : JSON.stringify(validationResult.errors, null, 2)
    );

    const coverResponse = await fetch(`${baseUrl}${body.video.cover_frame.uri}`, {
      method: "HEAD"
    });
    assert.equal(coverResponse.status, 200);
    assert.match(coverResponse.headers.get("content-type") || "", /image\/jpeg/u);
  }
);

test("POST /api/sample/analyze rejects unknown file_id", async () => {
  const response = await fetch(`${baseUrl}/api/sample/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ file_id: "missing-file-id" })
  });
  const body = (await response.json()) as { error: { code: string } };

  assert.equal(response.status, 404);
  assert.equal(body.error.code, "file_not_found");
});
