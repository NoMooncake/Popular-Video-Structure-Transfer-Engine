import fs from "node:fs";
import path from "node:path";

import { storageConfig } from "../config/storage.js";
import { runFFmpeg } from "../utils/ffmpeg.js";
import { findUploadedVideoById } from "./uploadService.js";
import { V2PipelineInputError } from "./v2PipelineService.js";
import type { V2ScriptSession } from "./v2ScriptCanvasService.js";
import { parseVideoMetadata, type VideoMetadata } from "./videoParserService.js";
import type { JsonObject } from "../v2/types.js";

const candidatePoolRootDir = path.join(storageConfig.outputDir, "v2-material-candidate-pools");
const candidatePoolFrameRootDir = path.join(storageConfig.outputDir, "v2-material-candidate-frames");

const maxCandidateSegmentDurationSeconds = 1.5;
const highFrequencyFrameIntervalSeconds = 0.5;

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (/^(true|1|yes)$/iu.test(value)) {
      return true;
    }

    if (/^(false|0|no)$/iu.test(value)) {
      return false;
    }
  }

  return fallback;
};

const sanitizeId = (value: string): string => {
  const normalizedValue = value.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 120);
  if (!normalizedValue) {
    throw new V2PipelineInputError("candidate pool id is invalid");
  }

  return normalizedValue;
};

const ensureCandidatePoolDir = (): void => {
  fs.mkdirSync(candidatePoolRootDir, { recursive: true });
};

const ensureCandidatePoolFrameDir = (candidatePoolId: string): string => {
  const outputDir = path.join(candidatePoolFrameRootDir, sanitizeId(candidatePoolId));
  fs.mkdirSync(outputDir, { recursive: true });
  return outputDir;
};

const getCandidatePoolPath = (candidatePoolId: string): string =>
  path.join(candidatePoolRootDir, `${sanitizeId(candidatePoolId)}.json`);

const publicCandidateFrameUri = (candidatePoolId: string, filename: string): string =>
  `/api/v2/material-candidate-pools/${encodeURIComponent(candidatePoolId)}/frames/${encodeURIComponent(filename)}`;

const getHighFrequencyTimestamps = (durationSeconds: number): number[] => {
  const timestampSet = new Set<number>();
  const timestampCount =
    Math.max(1, Math.ceil(durationSeconds / highFrequencyFrameIntervalSeconds) + 1);

  for (let index = 0; index < timestampCount; index += 1) {
    timestampSet.add(
      Number(
        Math.min(durationSeconds, index * highFrequencyFrameIntervalSeconds).toFixed(3)
      )
    );
  }

  timestampSet.add(Number(durationSeconds.toFixed(3)));

  return Array.from(timestampSet).sort((left, right) => left - right);
};

const getSegmentRanges = (durationSeconds: number): Array<{
  source_in_seconds: number;
  source_out_seconds: number;
  usable_duration_seconds: number;
}> => {
  const segmentCount = Math.max(
    1,
    Math.ceil(durationSeconds / maxCandidateSegmentDurationSeconds)
  );
  const segmentDuration = durationSeconds / segmentCount;

  return Array.from({ length: segmentCount }, (_value, index) => {
    const sourceIn = Number((index * segmentDuration).toFixed(3));
    const sourceOut = Number(
      Math.min(durationSeconds, sourceIn + segmentDuration).toFixed(3)
    );

    return {
      source_in_seconds: sourceIn,
      source_out_seconds: sourceOut,
      usable_duration_seconds: Number((sourceOut - sourceIn).toFixed(3))
    };
  });
};

const extractFrame = async (
  sourceVideoPath: string,
  outputPath: string,
  timestampSeconds: number
): Promise<void> => {
  await runFFmpeg(
    [
      "-y",
      "-i",
      sourceVideoPath,
      "-ss",
      String(timestampSeconds),
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outputPath
    ],
    [
      { path: sourceVideoPath, replacement: "[source material video]" },
      { path: outputPath, replacement: "[candidate frame]" }
    ]
  );
};

const getSafeExtractionTimestamp = (
  timestampSeconds: number,
  metadata: VideoMetadata
): number => {
  const durationSeconds = metadata.duration_seconds;
  if (durationSeconds <= 0.001) {
    return 0;
  }
  const frameDurationSeconds =
    metadata.fps && metadata.fps > 0 ? 1 / metadata.fps : 0.1;
  const latestDecodableTimestamp = Math.max(0, durationSeconds - frameDurationSeconds);

  return Number(
    Math.max(0, Math.min(timestampSeconds, latestDecodableTimestamp)).toFixed(3)
  );
};

const makeFrameFilename = (
  segmentId: string,
  frameIndex: number,
  timestampSeconds: number
): string =>
  `${sanitizeId(segmentId)}_frame_${String(frameIndex + 1).padStart(3, "0")}_${String(timestampSeconds).replace(/\./gu, "_")}s.jpg`;

const buildFrameRefs = async (
  candidatePoolId: string,
  sourceVideoPath: string,
  segmentId: string,
  timestamps: number[],
  metadata: VideoMetadata,
  extractFrames: boolean
): Promise<JsonObject[]> => {
  const outputDir = ensureCandidatePoolFrameDir(candidatePoolId);

  return Promise.all(
    timestamps.map(async (timestampSeconds, index): Promise<JsonObject> => {
      const filename = makeFrameFilename(segmentId, index, timestampSeconds);
      const outputPath = path.join(outputDir, filename);
      const existing = fs.existsSync(outputPath);
      let extractionStatus = extractFrames
        ? existing
          ? "cached"
          : "extracted"
        : "scheduled";

      if (extractFrames && !existing) {
        const extractionTimestamp = getSafeExtractionTimestamp(timestampSeconds, metadata);
        try {
          await extractFrame(sourceVideoPath, outputPath, extractionTimestamp);
        } catch (error) {
          if (extractionTimestamp === 0) {
            throw error;
          }

          await extractFrame(sourceVideoPath, outputPath, 0);
          extractionStatus = "extracted_from_fallback_start_frame";
        }
      }

      return {
        frame_id: `${segmentId}_frame_${String(index + 1).padStart(3, "0")}`,
        time_seconds: timestampSeconds,
        uri: publicCandidateFrameUri(candidatePoolId, filename),
        mime_type: "image/jpeg",
        width: metadata.width,
        height: metadata.height,
        extraction_status: extractionStatus
      };
    })
  );
};

const buildMaterialSegments = async (
  session: V2ScriptSession,
  candidatePoolId: string,
  extractFrames: boolean
): Promise<{ material_assets: JsonObject[]; material_segments: JsonObject[] }> => {
  const materialAssets: JsonObject[] = [];
  const materialSegments: JsonObject[] = [];

  for (const [slotIndex, slot] of session.slots.entries()) {
    const displayOrder = slot.display_order ?? slotIndex + 1;
    for (const [materialIndex, material] of slot.materials.entries()) {
      if (!material.file_id) {
        materialAssets.push({
          material_id: material.material_id,
          assigned_slot_id: slot.slot_id,
          assigned_slot_type: slot.slot_type,
          script_order_index: slotIndex,
          display_order: displayOrder,
          uri: material.uri,
          label: material.label,
          read_status: "skipped_missing_file_id"
        });
        continue;
      }

      const localPath = findUploadedVideoById(material.file_id);
      if (!localPath) {
        materialAssets.push({
          material_id: material.material_id,
          file_id: material.file_id,
          assigned_slot_id: slot.slot_id,
          assigned_slot_type: slot.slot_type,
          script_order_index: slotIndex,
          display_order: displayOrder,
          uri: material.uri,
          label: material.label,
          read_status: "skipped_local_file_unresolved"
        });
        continue;
      }

      const metadata = await parseVideoMetadata(localPath);
      const highFrequencyTimestamps = getHighFrequencyTimestamps(metadata.duration_seconds);
      materialAssets.push({
        material_id: material.material_id,
        file_id: material.file_id,
        uri: material.uri,
        label: material.label,
        assigned_slot_id: slot.slot_id,
        assigned_slot_type: slot.slot_type,
        script_order_index: slotIndex,
        display_order: displayOrder,
        local_path_resolved: true,
        metadata,
        high_frequency_frame_interval_seconds: highFrequencyFrameIntervalSeconds,
        high_frequency_frame_timestamps_seconds: highFrequencyTimestamps,
        read_status: "metadata_probed"
      });

      const segmentRanges = getSegmentRanges(metadata.duration_seconds);
      for (const [segmentIndex, range] of segmentRanges.entries()) {
        const segmentId = `${slot.slot_id}_seg_${String(materialIndex + 1).padStart(2, "0")}_${String(segmentIndex + 1).padStart(2, "0")}`;
        const segmentFrameTimestamps = highFrequencyTimestamps.filter(
          (timestamp) =>
            timestamp >= range.source_in_seconds && timestamp <= range.source_out_seconds
        );
        const midTimestamp = Number(
          ((range.source_in_seconds + range.source_out_seconds) / 2).toFixed(3)
        );
        const representativeFrameTimestamps = Array.from(
          new Set([
            range.source_in_seconds,
            midTimestamp,
            range.source_out_seconds
          ])
        ).sort((left, right) => left - right);
        const frameTimestamps =
          segmentFrameTimestamps.length > 0
            ? segmentFrameTimestamps
            : representativeFrameTimestamps;
        const frameRefs = await buildFrameRefs(
          candidatePoolId,
          localPath,
          segmentId,
          frameTimestamps,
          metadata,
          extractFrames
        );

        materialSegments.push({
          segment_id: segmentId,
          candidate_pool_id: candidatePoolId,
          source_material_id: material.material_id,
          file_id: material.file_id,
          uri: material.uri,
          assigned_slot_id: slot.slot_id,
          assigned_slot_type: slot.slot_type,
          script_order_index: slotIndex,
          display_order: displayOrder,
          source_in_seconds: range.source_in_seconds,
          source_out_seconds: range.source_out_seconds,
          usable_duration_seconds: range.usable_duration_seconds,
          representative_frame_timestamps_seconds: representativeFrameTimestamps,
          high_frequency_frame_timestamps_seconds: frameTimestamps,
          frames: frameRefs,
          segmentation_source: "uniform_high_frequency_candidate_split",
          pacing_inference_source: "user_request_first_material_pacing_not_authoritative",
          status: extractFrames
            ? "candidate_pool_ready"
            : "candidate_pool_frames_scheduled",
          next_step: "multimodal_refinement"
        });
      }
    }
  }

  return {
    material_assets: materialAssets,
    material_segments: materialSegments
  };
};

const writeCandidatePool = (candidatePool: JsonObject): JsonObject => {
  ensureCandidatePoolDir();
  fs.writeFileSync(
    getCandidatePoolPath(String(candidatePool.candidate_pool_id)),
    `${JSON.stringify(candidatePool, null, 2)}\n`
  );

  return candidatePool;
};

export const buildV2MaterialCandidatePool = async (
  payload: JsonObject
): Promise<JsonObject> => {
  if (!payload.script_session || typeof payload.script_session !== "object") {
    throw new V2PipelineInputError("script_session is required");
  }

  const session = payload.script_session as V2ScriptSession;
  const candidatePoolId = sanitizeId(
    normalizeOptionalString(payload.candidate_pool_id) ||
      `${session.session_id}_candidate_pool`
  );
  const extractFrames = normalizeBoolean(payload.extract_frames, true);
  const segmentResult = await buildMaterialSegments(session, candidatePoolId, extractFrames);
  const candidatePool = {
    candidate_pool_id: candidatePoolId,
    session_id: session.session_id,
    created_at: new Date().toISOString(),
    material_understanding_policy: {
      generated_structure_pacing: "user_request_first",
      source_material_pacing_is_authoritative: false,
      source_material_understanding:
        "uniform_high_frequency_candidate_frames_then_multimodal_refinement",
      segment_max_duration_seconds: maxCandidateSegmentDurationSeconds,
      frame_interval_seconds: highFrequencyFrameIntervalSeconds
    },
    material_assets: segmentResult.material_assets,
    material_segments: segmentResult.material_segments,
    summary: {
      material_count: segmentResult.material_assets.length,
      segment_count: segmentResult.material_segments.length,
      frame_count: segmentResult.material_segments.reduce(
        (total, segment) => total + (Array.isArray(segment.frames) ? segment.frames.length : 0),
        0
      ),
      status: "candidate_pool_ready"
    }
  };

  return writeCandidatePool(candidatePool);
};

export const readV2MaterialCandidatePool = (candidatePoolId: string): JsonObject => {
  const candidatePoolPath = getCandidatePoolPath(candidatePoolId);
  if (!fs.existsSync(candidatePoolPath)) {
    throw new V2PipelineInputError("material candidate pool not found", 404);
  }

  return JSON.parse(fs.readFileSync(candidatePoolPath, "utf8")) as JsonObject;
};

export const findV2MaterialCandidateFrameFile = (
  candidatePoolId: string,
  filename: string
): string | undefined => {
  const safeFilename = path.basename(filename);
  if (safeFilename !== filename || !safeFilename.endsWith(".jpg")) {
    return undefined;
  }

  const rootDir = path.resolve(candidatePoolFrameRootDir, sanitizeId(candidatePoolId));
  const filePath = path.resolve(rootDir, safeFilename);
  if (!filePath.startsWith(`${rootDir}${path.sep}`)) {
    return undefined;
  }

  return fs.existsSync(filePath) ? filePath : undefined;
};
