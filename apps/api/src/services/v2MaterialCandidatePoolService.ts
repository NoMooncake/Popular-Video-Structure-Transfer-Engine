import fs from "node:fs";
import path from "node:path";

import { storageConfig } from "../config/storage.js";
import { runFFmpeg } from "../utils/ffmpeg.js";
import { findUploadedVideoById } from "./uploadService.js";
import { V2PipelineInputError } from "./v2PipelineService.js";
import type { V2ScriptSession } from "./v2ScriptCanvasService.js";
import { parseVideoMetadata, type VideoMetadata } from "./videoParserService.js";
import { requestMultimodalJson } from "../v2/providers/apiJsonClient.js";
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

const asJsonObject = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};

const normalizeStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeOptionalString(item))
      .filter((item): item is string => Boolean(item));
  }

  const singleValue = normalizeOptionalString(value);
  return singleValue ? [singleValue] : [];
};

const normalizeNumber = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Number(Math.max(minimum, Math.min(maximum, numericValue)).toFixed(3));
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

const getCandidateFramePathFromUri = (
  candidatePoolId: string,
  frameUri: unknown
): string | undefined => {
  const normalizedFrameUri = normalizeOptionalString(frameUri);
  if (!normalizedFrameUri) {
    return undefined;
  }

  const encodedFilename = normalizedFrameUri.split("/").at(-1);
  if (!encodedFilename) {
    return undefined;
  }

  const filename = path.basename(decodeURIComponent(encodedFilename));
  if (filename !== decodeURIComponent(encodedFilename) || !filename.endsWith(".jpg")) {
    return undefined;
  }

  const framePath = path.join(
    candidatePoolFrameRootDir,
    sanitizeId(candidatePoolId),
    filename
  );

  return fs.existsSync(framePath) ? framePath : undefined;
};

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

const getFallbackSegmentRefinement = (segment: JsonObject, reason?: string): JsonObject => {
  const assignedSlotType = normalizeOptionalString(segment.assigned_slot_type) || "material";
  const assignedSlotId = normalizeOptionalString(segment.assigned_slot_id) || assignedSlotType;
  const label =
    normalizeOptionalString(segment.label) ||
    normalizeOptionalString(segment.source_material_id) ||
    assignedSlotId;

  return {
    ...segment,
    final_source_in_seconds: segment.source_in_seconds,
    final_source_out_seconds: segment.source_out_seconds,
    visual_tags: [assignedSlotType],
    usable_slot_types: [assignedSlotType],
    quality_score: 0.6,
    content_summary: `${label} 可作为 ${assignedSlotType} 的候选素材，等待多模态模型进一步确认。`,
    action_summary: "待多模态模型确认动作细节。",
    product_presence: "unknown",
    scene_type: "unknown",
    refinement_suggestion: {
      action: "keep",
      reason: reason || "multimodal provider unavailable"
    },
    refinement_source: "deterministic_fallback",
    refinement_status: "fallback_pending_multimodal"
  };
};

const normalizeProviderSegmentRefinements = (
  providerResponse: JsonObject
): Map<string, JsonObject> => {
  const rawSegments = Array.isArray(providerResponse.material_segments)
    ? providerResponse.material_segments
    : Array.isArray(providerResponse.segments)
      ? providerResponse.segments
      : [];

  const refinements = new Map<string, JsonObject>();
  for (const rawSegment of rawSegments) {
    const segment = asJsonObject(rawSegment);
    const segmentId = normalizeOptionalString(segment.segment_id);
    if (segmentId) {
      refinements.set(segmentId, segment);
    }
  }

  return refinements;
};

const applyProviderSegmentRefinement = (
  segment: JsonObject,
  providerSegment: JsonObject
): JsonObject => {
  const sourceInSeconds = Number(segment.source_in_seconds);
  const sourceOutSeconds = Number(segment.source_out_seconds);
  const boundedSourceInSeconds = Number.isFinite(sourceInSeconds) ? sourceInSeconds : 0;
  const boundedSourceOutSeconds =
    Number.isFinite(sourceOutSeconds) && sourceOutSeconds > boundedSourceInSeconds
      ? sourceOutSeconds
      : boundedSourceInSeconds + Number(segment.usable_duration_seconds || 0);
  const refinedInSeconds = normalizeNumber(
    providerSegment.refined_source_in_seconds ?? providerSegment.source_in_seconds,
    boundedSourceInSeconds,
    boundedSourceInSeconds,
    boundedSourceOutSeconds
  );
  const refinedOutSeconds = normalizeNumber(
    providerSegment.refined_source_out_seconds ?? providerSegment.source_out_seconds,
    boundedSourceOutSeconds,
    refinedInSeconds,
    boundedSourceOutSeconds
  );
  const hasUsableDuration = refinedOutSeconds - refinedInSeconds >= 0.2;
  const visualTags = normalizeStringArray(
    providerSegment.visual_tags ?? providerSegment.tags
  );
  const usableSlotTypes = normalizeStringArray(
    providerSegment.usable_slot_types ?? providerSegment.slot_types
  );

  return {
    ...segment,
    final_source_in_seconds: hasUsableDuration
      ? refinedInSeconds
      : segment.source_in_seconds,
    final_source_out_seconds: hasUsableDuration
      ? refinedOutSeconds
      : segment.source_out_seconds,
    visual_tags: visualTags,
    usable_slot_types:
      usableSlotTypes.length > 0
        ? usableSlotTypes
        : [normalizeOptionalString(segment.assigned_slot_type) || "material"],
    quality_score: normalizeNumber(providerSegment.quality_score, 0.7, 0, 1),
    content_summary:
      normalizeOptionalString(providerSegment.content_summary) ||
      normalizeOptionalString(providerSegment.summary) ||
      "多模态模型已读取该候选片段。",
    action_summary: normalizeOptionalString(providerSegment.action_summary),
    product_presence: normalizeOptionalString(providerSegment.product_presence),
    scene_type: normalizeOptionalString(providerSegment.scene_type),
    refinement_suggestion: asJsonObject(
      providerSegment.refinement_suggestion || providerSegment.edit_suggestion
    ),
    refinement_source: "multimodal_provider",
    refinement_status: hasUsableDuration ? "refined" : "provider_invalid_time_repaired"
  };
};

const buildRefinementProviderPayload = (
  session: V2ScriptSession,
  candidatePoolId: string,
  materialSegments: JsonObject[]
): JsonObject => {
  const slotSummaries = session.slots.map((slot) => ({
    slot_id: slot.slot_id,
    slot_type: slot.slot_type,
    slot_name: slot.slot_name,
    display_order: slot.display_order,
    required_duration: slot.required_duration,
    shot_description: slot.shot_description
  }));

  return {
    user_request: session.user_request,
    slots: slotSummaries,
    material_segments: materialSegments.map((segment) => ({
      segment_id: segment.segment_id,
      assigned_slot_id: segment.assigned_slot_id,
      assigned_slot_type: segment.assigned_slot_type,
      source_material_id: segment.source_material_id,
      source_in_seconds: segment.source_in_seconds,
      source_out_seconds: segment.source_out_seconds,
      usable_duration_seconds: segment.usable_duration_seconds,
      frame_times: segment.high_frequency_frame_timestamps_seconds,
      frames: Array.isArray(segment.frames)
        ? segment.frames.map((frame) => {
            const frameRecord = asJsonObject(frame);
            return {
              frame_id: frameRecord.frame_id,
              time_seconds: frameRecord.time_seconds,
              image_uri: getCandidateFramePathFromUri(candidatePoolId, frameRecord.uri)
            };
          })
        : []
    }))
  };
};

const refineMaterialSegments = async (
  session: V2ScriptSession,
  candidatePoolId: string,
  materialSegments: JsonObject[],
  useMultimodalProvider: boolean
): Promise<{ material_segments: JsonObject[]; refinement: JsonObject }> => {
  if (materialSegments.length === 0) {
    return {
      material_segments: [],
      refinement: {
        status: "skipped_empty_candidate_pool",
        provider_used: false
      }
    };
  }

  if (!useMultimodalProvider) {
    return {
      material_segments: materialSegments.map((segment) =>
        getFallbackSegmentRefinement(segment, "provider refinement disabled by request")
      ),
      refinement: {
        status: "deterministic_fallback",
        provider_used: false,
        reason: "provider refinement disabled by request"
      }
    };
  }

  try {
    const providerResponse = await requestMultimodalJson(
      "v2_refine_material_candidate_pool",
      [
        "你是广告素材理解和候选片段精修专家。",
        "你会收到脚本段落、候选素材片段和每段抽帧。请只输出合法 JSON object。",
        "不要改写脚本结构，不要根据素材长短判断广告节奏；用户需求和脚本段落优先。",
        "对每个 material_segments 项输出 segment_id、visual_tags、usable_slot_types、quality_score、content_summary、action_summary、product_presence、scene_type。",
        "如需建议调整起止点，输出 refined_source_in_seconds/refined_source_out_seconds，必须落在原片段 source_in_seconds/source_out_seconds 之内。",
        "如果片段不适合使用，quality_score 可以较低，但仍需保留该 segment_id。"
      ].join("\n"),
      buildRefinementProviderPayload(session, candidatePoolId, materialSegments)
    );
    const refinements = normalizeProviderSegmentRefinements(providerResponse);

    return {
      material_segments: materialSegments.map((segment) => {
        const segmentId = normalizeOptionalString(segment.segment_id);
        const refinement = segmentId ? refinements.get(segmentId) : undefined;
        return refinement
          ? applyProviderSegmentRefinement(segment, refinement)
          : getFallbackSegmentRefinement(segment, "provider omitted this segment");
      }),
      refinement: {
        status: "refined",
        provider_used: true,
        provider_response_segment_count: refinements.size
      }
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "multimodal provider failed";
    return {
      material_segments: materialSegments.map((segment) =>
        getFallbackSegmentRefinement(segment, reason)
      ),
      refinement: {
        status: "deterministic_fallback",
        provider_used: false,
        reason
      }
    };
  }
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
  const refineSegments = normalizeBoolean(payload.refine_segments, true);
  const useMultimodalProvider = normalizeBoolean(payload.use_multimodal_provider, true);
  const segmentResult = await buildMaterialSegments(session, candidatePoolId, extractFrames);
  const refinementResult = refineSegments
    ? await refineMaterialSegments(
        session,
        candidatePoolId,
        segmentResult.material_segments,
        useMultimodalProvider
      )
    : {
        material_segments: segmentResult.material_segments,
        refinement: {
          status: "skipped_by_request",
          provider_used: false
        }
      };
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
      frame_interval_seconds: highFrequencyFrameIntervalSeconds,
      refinement_enabled: refineSegments
    },
    material_assets: segmentResult.material_assets,
    material_segments: refinementResult.material_segments,
    refinement: refinementResult.refinement,
    summary: {
      material_count: segmentResult.material_assets.length,
      segment_count: refinementResult.material_segments.length,
      frame_count: refinementResult.material_segments.reduce(
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
