import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { storageConfig } from "../config/storage.js";
import { findUploadedVideoById, type UploadedVideoFile } from "./uploadService.js";
import {
  buildV2DeterministicMaterialCoverage,
  V2PipelineInputError
} from "./v2PipelineService.js";
import { parseVideoMetadata } from "./videoParserService.js";
import type { JsonObject, V2PipelineRequest, V2VideoRef } from "../v2/types.js";

type V2ScriptSlotMaterial = {
  material_id: string;
  file_id?: string;
  uri: string;
  label?: string;
  role: "user_material";
  assigned_at: string;
};

type V2ScriptSlot = {
  slot_id: string;
  slot_type: string;
  slot_name?: string;
  required_duration: number;
  original_required_duration?: number;
  shot_description: string;
  voiceover_text?: string;
  copy?: string;
  material_folder_id: string;
  editable_fields: string[];
  locked_fields: string[];
  materials: V2ScriptSlotMaterial[];
};

type V2ScriptSession = {
  session_id: string;
  created_at: string;
  updated_at: string;
  source_pipeline_id?: string;
  target_duration_seconds: number;
  user_request: JsonObject;
  slots: V2ScriptSlot[];
};

const scriptSessionRootDir = path.join(storageConfig.outputDir, "v2-script-sessions");

const asJsonObject = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeOptionalString(item))
      .filter((item): item is string => Boolean(item));
  }

  const singleValue = normalizeOptionalString(value);
  return singleValue ? [singleValue] : [];
};

const normalizePositiveSeconds = (
  value: unknown,
  fieldName: string,
  fallback?: number
): number => {
  const parsedValue = Number(value ?? fallback);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new V2PipelineInputError(`${fieldName} must be a positive number`);
  }

  return Number(parsedValue.toFixed(3));
};

const ensureScriptSessionDir = (): void => {
  fs.mkdirSync(scriptSessionRootDir, { recursive: true });
};

const getScriptSessionPath = (sessionId: string): string => {
  const normalizedSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/gu, "");
  if (!normalizedSessionId) {
    throw new V2PipelineInputError("session_id is invalid");
  }

  return path.join(scriptSessionRootDir, `${normalizedSessionId}.json`);
};

const saveScriptSession = (session: V2ScriptSession): V2ScriptSession => {
  ensureScriptSessionDir();
  fs.writeFileSync(
    getScriptSessionPath(session.session_id),
    `${JSON.stringify(session, null, 2)}\n`
  );
  return session;
};

export const getV2ScriptSession = (sessionId: string): V2ScriptSession => {
  const sessionPath = getScriptSessionPath(sessionId);
  if (!fs.existsSync(sessionPath)) {
    throw new V2PipelineInputError("script session not found", 404);
  }

  return JSON.parse(fs.readFileSync(sessionPath, "utf8")) as V2ScriptSession;
};

const getNestedArray = (root: JsonObject, pathParts: string[]): unknown[] => {
  let current: unknown = root;
  for (const pathPart of pathParts) {
    current = asJsonObject(current)[pathPart];
  }

  return Array.isArray(current) ? current : [];
};

const getPipelineSlots = (payload: JsonObject): JsonObject[] => {
  const directSlots = Array.isArray(payload.slots) ? payload.slots : [];
  if (directSlots.length > 0) {
    return directSlots.map(asJsonObject);
  }

  const pipelineResult = asJsonObject(payload.pipeline_result);
  const materialCoverage = asJsonObject(
    payload.material_coverage ||
      asJsonObject(asJsonObject(pipelineResult.stages).material_coverage)
  );
  const coverageSlots = Array.isArray(materialCoverage.slot_coverage)
    ? materialCoverage.slot_coverage
    : [];
  if (coverageSlots.length > 0) {
    return coverageSlots.map(asJsonObject);
  }

  const architecture =
    payload.fillable_architecture ||
    asJsonObject(asJsonObject(pipelineResult.stages).fillable_architecture);
  const architectureRoot = asJsonObject(architecture);
  const architectureSlots = [
    ...getNestedArray(architectureRoot, ["slots"]),
    ...getNestedArray(architectureRoot, ["structure_slots"]),
    ...getNestedArray(architectureRoot, ["editable_slots"]),
    ...getNestedArray(architectureRoot, ["slot_planning"]),
    ...getNestedArray(architectureRoot, ["final_plan", "slot_planning"]),
    ...getNestedArray(architectureRoot, ["result", "ad_structure", "slots"]),
    ...getNestedArray(architectureRoot, ["result", "fillable_architecture", "slots"])
  ];

  return architectureSlots.map(asJsonObject);
};

const getTargetDurationSeconds = (payload: JsonObject, slots: JsonObject[]): number => {
  const pipelineResult = asJsonObject(payload.pipeline_result);
  const summary = asJsonObject(pipelineResult.summary);
  const options = asJsonObject(payload.options);
  const explicitDuration =
    payload.target_duration_seconds ||
    options.target_duration_seconds ||
    summary.target_duration_seconds;
  if (explicitDuration !== undefined) {
    return normalizePositiveSeconds(explicitDuration, "target_duration_seconds");
  }

  const totalSlotDuration = slots.reduce((total, slot) => {
    const duration = Number(
      slot.required_duration ??
        slot.duration_seconds ??
        slot.slot_duration_seconds ??
        slot.target_duration_seconds
    );

    return Number.isFinite(duration) && duration > 0 ? total + duration : total;
  }, 0);

  return Number((totalSlotDuration || 30).toFixed(3));
};

const getSlotRequiredDuration = (
  slot: JsonObject,
  index: number,
  slotCount: number,
  targetDurationSeconds: number
): number => {
  const explicitDuration =
    slot.required_duration ??
    slot.duration_seconds ??
    slot.slot_duration_seconds ??
    slot.target_duration_seconds;
  if (explicitDuration !== undefined) {
    return normalizePositiveSeconds(explicitDuration, "slot required_duration");
  }

  const timeRange = asJsonObject(slot.time_range);
  const startSeconds = Number(timeRange.start_seconds ?? timeRange.start);
  const endSeconds = Number(timeRange.end_seconds ?? timeRange.end);
  if (
    Number.isFinite(startSeconds) &&
    Number.isFinite(endSeconds) &&
    endSeconds > startSeconds
  ) {
    return Number((endSeconds - startSeconds).toFixed(3));
  }

  return Number((targetDurationSeconds / Math.max(1, slotCount)).toFixed(3));
};

const getSlotMaterials = (slot: JsonObject): V2ScriptSlotMaterial[] => {
  const materials = [
    ...(Array.isArray(slot.materials) ? slot.materials : []),
    ...(Array.isArray(slot.assigned_materials) ? slot.assigned_materials : []),
    ...(Array.isArray(slot.matched_materials) ? slot.matched_materials : []),
    ...(Array.isArray(slot.direct_video_reference_materials)
      ? slot.direct_video_reference_materials
      : [])
  ].map(asJsonObject);
  const seen = new Set<string>();

  return materials
    .map((material, index): V2ScriptSlotMaterial | undefined => {
      const fileId = normalizeOptionalString(material.file_id);
      const uri =
        normalizeOptionalString(material.uri) ||
        (fileId ? `/api/upload/files/${fileId}` : undefined);
      if (!uri) {
        return undefined;
      }

      const materialId =
        normalizeOptionalString(material.material_id) ||
        normalizeOptionalString(material.id) ||
        `slot_material_${String(index + 1).padStart(2, "0")}`;
      const dedupeKey = `${fileId || ""}:${uri}:${materialId}`;
      if (seen.has(dedupeKey)) {
        return undefined;
      }
      seen.add(dedupeKey);

      return {
        material_id: materialId,
        file_id: fileId,
        uri,
        label: normalizeOptionalString(material.label),
        role: "user_material",
        assigned_at: new Date().toISOString()
      };
    })
    .filter((material): material is V2ScriptSlotMaterial => Boolean(material));
};

const normalizeScriptSlot = (
  slot: JsonObject,
  index: number,
  slotCount: number,
  targetDurationSeconds: number
): V2ScriptSlot => {
  const slotId =
    normalizeOptionalString(slot.slot_id) ||
    normalizeOptionalString(slot.id) ||
    `slot_${String(index + 1).padStart(2, "0")}`;
  const slotType =
    normalizeOptionalString(slot.slot_type) ||
    normalizeOptionalString(slot.slot) ||
    normalizeOptionalString(slot.slot_name) ||
    slotId;
  const slotName =
    normalizeOptionalString(slot.slot_name) ||
    normalizeOptionalString(slot.name) ||
    normalizeOptionalString(slot.migration_result_title);
  const requiredDuration = getSlotRequiredDuration(
    slot,
    index,
    slotCount,
    targetDurationSeconds
  );
  const shotDescription =
    normalizeOptionalString(slot.shot_description) ||
    normalizeOptionalString(slot.visual_goal) ||
    normalizeOptionalString(slot.visual_direction) ||
    normalizeOptionalString(slot.description) ||
    normalizeOptionalString(asJsonObject(slot.frontend_display).shot_description) ||
    "待补充分镜描述";
  const voiceoverText =
    normalizeOptionalString(slot.voiceover_text) ||
    normalizeOptionalString(slot.copy) ||
    normalizeOptionalString(slot.copy_direction) ||
    normalizeOptionalString(slot.subtitle_or_vo_direction) ||
    normalizeOptionalString(asJsonObject(slot.frontend_display).copy);

  return {
    slot_id: slotId,
    slot_type: slotType,
    slot_name: slotName,
    required_duration: requiredDuration,
    original_required_duration: requiredDuration,
    shot_description: shotDescription,
    voiceover_text: voiceoverText,
    copy: voiceoverText,
    material_folder_id: `${slotId}_materials`,
    editable_fields: ["required_duration", "voiceover_text", "material_ref"],
    locked_fields: ["shot_description", "visual", "packaging", "migration_result"],
    materials: getSlotMaterials(slot)
  };
};

export const createV2ScriptSession = (payload: JsonObject): V2ScriptSession => {
  const slots = getPipelineSlots(payload);
  if (slots.length === 0) {
    throw new V2PipelineInputError("slots or pipeline_result material coverage is required");
  }

  const targetDurationSeconds = getTargetDurationSeconds(payload, slots);
  const now = new Date().toISOString();
  const pipelineResult = asJsonObject(payload.pipeline_result);
  const session: V2ScriptSession = {
    session_id: `v2_script_${crypto.randomUUID()}`,
    created_at: now,
    updated_at: now,
    source_pipeline_id: normalizeOptionalString(pipelineResult.id),
    target_duration_seconds: targetDurationSeconds,
    user_request: asJsonObject(
      payload.user_request ||
        asJsonObject(pipelineResult.input).user_request ||
        asJsonObject(asJsonObject(pipelineResult.stages).production_plan).user_request
    ),
    slots: slots.map((slot, index) =>
      normalizeScriptSlot(slot, index, slots.length, targetDurationSeconds)
    )
  };

  return saveScriptSession(session);
};

const getMutableSessionSlot = (
  session: V2ScriptSession,
  slotId: string
): V2ScriptSlot => {
  const slot = session.slots.find((item) => item.slot_id === slotId);
  if (!slot) {
    throw new V2PipelineInputError("script slot not found", 404);
  }

  return slot;
};

export const updateV2ScriptSlot = (
  sessionId: string,
  slotId: string,
  payload: JsonObject
): V2ScriptSession => {
  const immutableFields = [
    "shot_description",
    "visual",
    "visual_goal",
    "visual_direction",
    "packaging",
    "migration_result",
    "slot_type"
  ];
  const blockedField = immutableFields.find((field) => field in payload);
  if (blockedField) {
    throw new V2PipelineInputError(`${blockedField} is locked on the script page`);
  }

  const session = getV2ScriptSession(sessionId);
  const slot = getMutableSessionSlot(session, slotId);
  if (
    payload.required_duration !== undefined ||
    payload.duration_seconds !== undefined ||
    payload.duration !== undefined
  ) {
    slot.required_duration = normalizePositiveSeconds(
      payload.required_duration ?? payload.duration_seconds ?? payload.duration,
      "required_duration"
    );
  }

  if (payload.voiceover_text !== undefined || payload.copy !== undefined) {
    const voiceoverText = normalizeOptionalString(
      payload.voiceover_text ?? payload.copy
    );
    slot.voiceover_text = voiceoverText;
    slot.copy = voiceoverText;
  }

  session.target_duration_seconds = Number(
    session.slots.reduce((total, item) => total + item.required_duration, 0).toFixed(3)
  );
  session.updated_at = new Date().toISOString();

  return saveScriptSession(session);
};

const normalizeMaterialFromFileId = (
  slot: V2ScriptSlot,
  fileId: string,
  index: number,
  label?: string
): V2ScriptSlotMaterial => {
  if (!findUploadedVideoById(fileId)) {
    throw new V2PipelineInputError(`uploaded material not found: ${fileId}`, 404);
  }

  return {
    material_id: `${slot.slot_id}_material_${String(slot.materials.length + index + 1).padStart(2, "0")}`,
    file_id: fileId,
    uri: `/api/upload/files/${fileId}`,
    label,
    role: "user_material",
    assigned_at: new Date().toISOString()
  };
};

export const addV2ScriptSlotMaterials = (
  sessionId: string,
  slotId: string,
  payload: JsonObject
): V2ScriptSession => {
  const session = getV2ScriptSession(sessionId);
  const slot = getMutableSessionSlot(session, slotId);
  const fileIds = normalizeStringArray(payload.file_ids ?? payload.file_id);
  const materialRecords = Array.isArray(payload.materials)
    ? payload.materials.map(asJsonObject)
    : [];
  const nextMaterials = [
    ...fileIds.map((fileId, index) =>
      normalizeMaterialFromFileId(slot, fileId, index)
    ),
    ...materialRecords.map((material, index): V2ScriptSlotMaterial => {
      const fileId =
        normalizeOptionalString(material.file_id) ||
        normalizeOptionalString(material.fileId);
      const uri =
        normalizeOptionalString(material.uri) ||
        (fileId ? `/api/upload/files/${fileId}` : undefined);
      if (!uri) {
        throw new V2PipelineInputError("slot material uri or file_id is required");
      }
      if (fileId && !findUploadedVideoById(fileId)) {
        throw new V2PipelineInputError(`uploaded material not found: ${fileId}`, 404);
      }

      return {
        material_id:
          normalizeOptionalString(material.material_id) ||
          `${slot.slot_id}_material_${String(slot.materials.length + fileIds.length + index + 1).padStart(2, "0")}`,
        file_id: fileId,
        uri,
        label: normalizeOptionalString(material.label),
        role: "user_material",
        assigned_at: new Date().toISOString()
      };
    })
  ];

  if (nextMaterials.length === 0) {
    throw new V2PipelineInputError("file_ids or materials is required");
  }

  const existingKeys = new Set(
    slot.materials.map((material) => material.file_id || material.uri)
  );
  for (const material of nextMaterials) {
    const key = material.file_id || material.uri;
    if (!existingKeys.has(key)) {
      slot.materials.push(material);
      existingKeys.add(key);
    }
  }

  session.updated_at = new Date().toISOString();
  return saveScriptSession(session);
};

export const addUploadedFilesToV2ScriptSlot = (
  sessionId: string,
  slotId: string,
  files: UploadedVideoFile[]
): V2ScriptSession => {
  return addV2ScriptSlotMaterials(sessionId, slotId, {
    materials: files.map((file) => ({
      file_id: file.file_id,
      uri: file.path,
      label: file.original_filename,
      material_id: file.file_id
    }))
  });
};

const getSlotMaterialRefs = (session: V2ScriptSession): V2VideoRef[] => {
  const refs: V2VideoRef[] = [];
  for (const slot of session.slots) {
    for (const material of slot.materials) {
      refs.push({
        file_id: material.file_id,
        uri: material.uri,
        label: material.label || material.material_id,
        role: "user_material"
      });
    }
  }

  return refs;
};

const getSlotMaterialLabels = (slot: V2ScriptSlot): string[] =>
  slot.materials.map((material) => material.label || material.material_id);

const makeCoverageRequest = (
  session: V2ScriptSession,
  acceptedDurationShortSlots: string[] = []
): Required<V2PipelineRequest> => {
  return {
    reference_videos: [],
    reference_file_ids: [],
    user_materials: getSlotMaterialRefs(session),
    user_material_file_ids: [],
    text_assets: [],
    user_request: {
      goal:
        normalizeOptionalString(session.user_request.goal) ||
        normalizeOptionalString(session.user_request.target_topic) ||
        "商业广告成片"
    },
    options: {
      image_candidate_count: 4,
      generate_image_candidates: false,
      target_duration_seconds: session.target_duration_seconds,
      allow_fallback: true,
      accepted_duration_short_slots: acceptedDurationShortSlots
    }
  };
};

const makeCoverageArchitecture = (session: V2ScriptSession): JsonObject => ({
  slots: session.slots.map((slot) => ({
    slot_id: slot.slot_id,
    slot_type: slot.slot_type,
    slot_name: slot.slot_name,
    duration_seconds: slot.required_duration,
    visual_direction: slot.shot_description,
    copy_direction: slot.voiceover_text,
    source_material: getSlotMaterialLabels(slot)
  }))
});

const makeCoverageMaterialAnalysis = (session: V2ScriptSession): JsonObject => ({
  coverage_by_slot_type: session.slots.map((slot) => ({
    slot_type: slot.slot_type,
    material_refs: getSlotMaterialLabels(slot)
  })),
  slot_material_mapping: Object.fromEntries(
    session.slots.map((slot) => [
      slot.slot_type,
      {
        materials: getSlotMaterialLabels(slot)
      }
    ])
  )
});

const buildSegmentForMaterial = async (
  slot: V2ScriptSlot,
  material: V2ScriptSlotMaterial,
  materialIndex: number
): Promise<JsonObject[]> => {
  if (!material.file_id) {
    return [];
  }

  const localPath = findUploadedVideoById(material.file_id);
  if (!localPath) {
    return [];
  }

  const metadata = await parseVideoMetadata(localPath);
  const duration = metadata.duration_seconds;
  const maxSegmentDuration = duration <= 8 ? 1.5 : duration <= 20 ? 2.5 : 3.5;
  const segmentCount = Math.max(1, Math.ceil(duration / maxSegmentDuration));
  const segmentDuration = duration / segmentCount;

  return Array.from({ length: segmentCount }, (_value, segmentIndex) => {
    const sourceIn = Number((segmentIndex * segmentDuration).toFixed(3));
    const sourceOut = Number(
      Math.min(duration, sourceIn + segmentDuration).toFixed(3)
    );
    const mid = Number(((sourceIn + sourceOut) / 2).toFixed(3));

    return {
      segment_id: `${slot.slot_id}_seg_${String(materialIndex + 1).padStart(2, "0")}_${String(segmentIndex + 1).padStart(2, "0")}`,
      source_material_id: material.material_id,
      file_id: material.file_id,
      uri: material.uri,
      assigned_slot_id: slot.slot_id,
      assigned_slot_type: slot.slot_type,
      source_in_seconds: sourceIn,
      source_out_seconds: sourceOut,
      usable_duration_seconds: Number((sourceOut - sourceIn).toFixed(3)),
      representative_frame_timestamps_seconds: [sourceIn, mid, sourceOut],
      segmentation_source: "deterministic_duration_split",
      status: "ready_for_multimodal_refinement"
    };
  });
};

export const buildV2ScriptMaterialSegments = async (
  session: V2ScriptSession
): Promise<JsonObject[]> => {
  const nestedSegments = await Promise.all(
    session.slots.flatMap((slot) =>
      slot.materials.map((material, index) =>
        buildSegmentForMaterial(slot, material, index)
      )
    )
  );

  return nestedSegments.flat();
};

export const revalidateV2CanvasFromScript = async (
  payload: JsonObject
): Promise<JsonObject> => {
  const session =
    payload.script_session && typeof payload.script_session === "object"
      ? (payload.script_session as V2ScriptSession)
      : getV2ScriptSession(
          normalizeOptionalString(payload.session_id) ||
            normalizeOptionalString(payload.script_session_id) ||
            ""
        );
  const acceptedDurationShortSlots = normalizeStringArray(
    payload.accepted_duration_short_slots
  );
  const materialSegments = await buildV2ScriptMaterialSegments(session);
  const materialCoverage = await buildV2DeterministicMaterialCoverage(
    makeCoverageRequest(session, acceptedDurationShortSlots),
    makeCoverageArchitecture(session),
    makeCoverageMaterialAnalysis(session)
  );

  return {
    session_id: session.session_id,
    target_duration_seconds: session.target_duration_seconds,
    script_slots: session.slots,
    material_segments: materialSegments,
    material_coverage: materialCoverage,
    canvas_nodes: materialCoverage.slot_coverage.map((coverage) => ({
      slot_id: coverage.slot_id,
      slot_type: coverage.slot_type,
      label: coverage.frontend_coverage_label,
      coverage_status: coverage.frontend_coverage_status,
      required_duration: coverage.required_duration,
      matched_material_duration: coverage.matched_material_duration,
      missing_duration: coverage.missing_duration,
      needs_ai_completion: coverage.needs_ai_completion,
      recommended_video_prompt: coverage.recommended_video_prompt,
      recommended_aigc_prompt: coverage.recommended_aigc_prompt,
      available_generation_paths: coverage.available_generation_paths,
      direct_video_reference_materials: coverage.direct_video_reference_materials
    }))
  };
};
