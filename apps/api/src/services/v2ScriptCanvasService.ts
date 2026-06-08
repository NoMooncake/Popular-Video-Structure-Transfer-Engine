import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { storageConfig } from "../config/storage.js";
import { createV2CanvasSessionFromRevalidateResult } from "./v2CanvasSessionService.js";
import { findUploadedVideoById, type UploadedVideoFile } from "./uploadService.js";
import { buildV2MaterialCandidatePool } from "./v2MaterialCandidatePoolService.js";
import {
  buildV2DeterministicMaterialCoverage,
  V2PipelineInputError
} from "./v2PipelineService.js";
import type { JsonObject, V2PipelineRequest, V2VideoRef } from "../v2/types.js";

export type V2ScriptSlotMaterial = {
  material_id: string;
  file_id?: string;
  uri: string;
  label?: string;
  role: "user_material";
  assigned_at: string;
};

export type V2ScriptSlot = {
  slot_id: string;
  slot_type: string;
  slot_name?: string;
  display_order: number;
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

export type V2ScriptSession = {
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
    display_order: index + 1,
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

const normalizeSlotOrderIds = (payload: JsonObject): string[] => {
  const slotIds = payload.slot_ids ?? payload.ordered_slot_ids;
  if (!Array.isArray(slotIds)) {
    throw new V2PipelineInputError("slot_ids must include every script slot in final order");
  }

  return slotIds.map((slotId, index) => {
    const normalizedSlotId = normalizeOptionalString(slotId);
    if (!normalizedSlotId) {
      throw new V2PipelineInputError(`slot_ids[${index}] is invalid`);
    }

    return normalizedSlotId;
  });
};

export const reorderV2ScriptSlots = (
  sessionId: string,
  payload: JsonObject
): V2ScriptSession => {
  const session = getV2ScriptSession(sessionId);
  const orderedSlotIds = normalizeSlotOrderIds(payload);
  if (orderedSlotIds.length !== session.slots.length) {
    throw new V2PipelineInputError("slot_ids must include every script slot exactly once");
  }

  const uniqueSlotIds = new Set(orderedSlotIds);
  if (uniqueSlotIds.size !== orderedSlotIds.length) {
    throw new V2PipelineInputError("slot_ids contains duplicate script slots");
  }

  const slotById = new Map(session.slots.map((slot) => [slot.slot_id, slot]));
  const unknownSlotId = orderedSlotIds.find((slotId) => !slotById.has(slotId));
  if (unknownSlotId) {
    throw new V2PipelineInputError(`script slot not found in session: ${unknownSlotId}`, 404);
  }

  session.slots = orderedSlotIds.map((slotId, index) => {
    const slot = slotById.get(slotId);
    if (!slot) {
      throw new V2PipelineInputError(`script slot not found in session: ${slotId}`, 404);
    }

    return {
      ...slot,
      display_order: index + 1
    };
  });
  session.updated_at = new Date().toISOString();

  return saveScriptSession(session);
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

const getNumber = (value: unknown, fallback = 0): number => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
};

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
  slots: session.slots.map((slot, index) => ({
    slot_id: slot.slot_id,
    slot_type: slot.slot_type,
    slot_name: slot.slot_name,
    script_order_index: index,
    display_order: slot.display_order ?? index + 1,
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

const getSlotCoverageKey = (slotId: string, slotType: string): string[] => [
  slotId,
  slotType
];

const isAcceptedDurationShortSlot = (
  acceptedSlots: Set<string>,
  slotId: string,
  slotType: string
): boolean => acceptedSlots.has(slotId) || acceptedSlots.has(slotType);

const getSegmentFinalDuration = (segment: JsonObject): number => {
  const finalIn = getNumber(segment.final_source_in_seconds, getNumber(segment.source_in_seconds));
  const finalOut = getNumber(
    segment.final_source_out_seconds,
    getNumber(segment.source_out_seconds)
  );
  const finalDuration = finalOut - finalIn;
  if (finalDuration > 0) {
    return Number(finalDuration.toFixed(3));
  }

  return getNumber(segment.usable_duration_seconds);
};

const isSegmentUsableForSlot = (segment: JsonObject, slot: V2ScriptSlot): boolean => {
  if (normalizeOptionalString(segment.assigned_slot_id) === slot.slot_id) {
    return true;
  }

  const usableSlotTypes = normalizeStringArray(segment.usable_slot_types);
  return usableSlotTypes.includes(slot.slot_type) || usableSlotTypes.includes(slot.slot_id);
};

const makeSegmentAssignment = (
  segment: JsonObject,
  matchedDuration: number
): JsonObject => ({
  segment_id: segment.segment_id,
  source_material_id: segment.source_material_id,
  file_id: segment.file_id,
  uri: segment.uri,
  source_in_seconds: segment.final_source_in_seconds ?? segment.source_in_seconds,
  source_out_seconds: segment.final_source_out_seconds ?? segment.source_out_seconds,
  matched_material_duration: matchedDuration,
  quality_score: segment.quality_score,
  visual_tags: segment.visual_tags,
  usable_slot_types: segment.usable_slot_types,
  content_summary: segment.content_summary,
  frames: segment.frames,
  refinement_source: segment.refinement_source,
  refinement_status: segment.refinement_status
});

const makeDirectVideoReferenceMaterialsFromSegments = (
  assignedSegments: JsonObject[],
  candidateSegments: JsonObject[]
): JsonObject[] => {
  const sourceSegments = assignedSegments.length > 0 ? assignedSegments : candidateSegments;

  return sourceSegments.map((segment) => ({
    segment_id: segment.segment_id,
    source_material_id: segment.source_material_id,
    file_id: segment.file_id,
    uri: segment.uri,
    source_in_seconds: segment.source_in_seconds,
    source_out_seconds: segment.source_out_seconds,
    matched_material_duration: segment.matched_material_duration,
    quality_score: segment.quality_score,
    content_summary: segment.content_summary,
    frames: segment.frames
  }));
};

const buildSegmentAwareMaterialCoverage = (
  session: V2ScriptSession,
  materialSegments: JsonObject[],
  baseCoverage: JsonObject,
  acceptedDurationShortSlots: string[]
): JsonObject => {
  const acceptedSlots = new Set(acceptedDurationShortSlots);
  const baseSlotCoverage = Array.isArray(baseCoverage.slot_coverage)
    ? baseCoverage.slot_coverage.map(asJsonObject)
    : [];
  const baseCoverageByKey = new Map<string, JsonObject>();
  for (const coverage of baseSlotCoverage) {
    const slotId = normalizeOptionalString(coverage.slot_id);
    const slotType = normalizeOptionalString(coverage.slot_type);
    for (const key of getSlotCoverageKey(slotId || "", slotType || "")) {
      if (key) {
        baseCoverageByKey.set(key, coverage);
      }
    }
  }

  const slotCoverage = session.slots.map((slot) => {
    const base =
      baseCoverageByKey.get(slot.slot_id) ||
      baseCoverageByKey.get(slot.slot_type) ||
      {};
    const candidateSegments = materialSegments
      .filter((segment) => isSegmentUsableForSlot(asJsonObject(segment), slot))
      .map(asJsonObject)
      .sort(
        (left, right) =>
          getNumber(right.quality_score, 0.5) - getNumber(left.quality_score, 0.5)
      );
    let requiredRemaining = slot.required_duration;
    const assignedSegments: JsonObject[] = [];

    for (const segment of candidateSegments) {
      if (requiredRemaining <= 0) {
        break;
      }

      const segmentDuration = getSegmentFinalDuration(segment);
      if (segmentDuration <= 0) {
        continue;
      }

      const matchedDuration = Number(Math.min(requiredRemaining, segmentDuration).toFixed(3));
      assignedSegments.push(makeSegmentAssignment(segment, matchedDuration));
      requiredRemaining = Number((requiredRemaining - matchedDuration).toFixed(3));
    }

    const matchedMaterialDuration = Number(
      assignedSegments
        .reduce((total, segment) => total + getNumber(segment.matched_material_duration), 0)
        .toFixed(3)
    );
    const coverageStatus =
      matchedMaterialDuration >= slot.required_duration
        ? "covered"
        : matchedMaterialDuration > 0
          ? "partial"
          : "missing";
    const durationShortAccepted =
      coverageStatus === "partial" &&
      isAcceptedDurationShortSlot(acceptedSlots, slot.slot_id, slot.slot_type);
    const frontendCoverageStatus =
      coverageStatus === "covered" || durationShortAccepted
        ? "fully_matched"
        : coverageStatus === "partial"
          ? "structure_complete_duration_short"
          : "material_insufficient";
    const missingDuration = Number(
      Math.max(0, slot.required_duration - matchedMaterialDuration).toFixed(3)
    );
    const directVideoReferenceMaterials = makeDirectVideoReferenceMaterialsFromSegments(
      assignedSegments,
      candidateSegments
    );
    const availableGenerationPaths =
      frontendCoverageStatus === "fully_matched"
        ? []
        : [
            ...(directVideoReferenceMaterials.length > 0
              ? ["direct_video_from_material_frame"]
              : []),
            "generate_image_then_video"
          ];
    const availableUserActions =
      frontendCoverageStatus === "structure_complete_duration_short"
        ? [
            "accept_current_material_as_sufficient",
            ...(availableGenerationPaths.includes("direct_video_from_material_frame")
              ? ["generate_direct_video_from_material_frame"]
              : []),
            "generate_image_then_video"
          ]
        : frontendCoverageStatus === "material_insufficient"
          ? [
              ...(availableGenerationPaths.includes("direct_video_from_material_frame")
                ? ["generate_direct_video_from_material_frame"]
                : []),
              "generate_image_then_video"
            ]
          : durationShortAccepted
            ? ["reopen_ai_completion"]
            : [];
    const gapReason =
      frontendCoverageStatus === "fully_matched"
        ? undefined
        : matchedMaterialDuration > 0
          ? `已匹配 ${matchedMaterialDuration}s，但该段需要 ${slot.required_duration}s。`
          : "该段文件夹内没有可用素材片段。";

    return {
      ...base,
      slot_id: slot.slot_id,
      slot_type: slot.slot_type,
      slot_name: slot.slot_name,
      required_duration: slot.required_duration,
      matched_material_duration: matchedMaterialDuration,
      coverage_status: coverageStatus,
      frontend_coverage_status: frontendCoverageStatus,
      frontend_coverage_label:
        frontendCoverageStatus === "fully_matched"
          ? "完全匹配"
          : frontendCoverageStatus === "structure_complete_duration_short"
            ? "结构完整，但时长不足"
            : "素材不够",
      missing_duration: missingDuration,
      ai_completion_required_duration:
        frontendCoverageStatus === "fully_matched"
          ? 0
          : missingDuration || slot.required_duration,
      assigned_segments: assignedSegments,
      matched_material_segments: assignedSegments,
      candidate_material_segments: candidateSegments,
      assigned_materials: assignedSegments,
      matched_materials: assignedSegments,
      needs_ai_completion: frontendCoverageStatus !== "fully_matched",
      gap_reason: gapReason,
      available_generation_paths: availableGenerationPaths,
      available_user_actions: availableUserActions,
      direct_video_reference_materials: directVideoReferenceMaterials,
      user_duration_short_decision: durationShortAccepted
        ? "accepted_as_sufficient"
        : coverageStatus === "partial"
          ? "pending"
          : "not_applicable",
      matching_source: "refined_material_segments",
      semantic_matching_used: candidateSegments.some(
        (segment) => segment.refinement_source === "multimodal_provider"
      )
    };
  });
  const fullyMatched = slotCoverage.every(
    (coverage) => coverage.frontend_coverage_status === "fully_matched"
  );

  return {
    ...baseCoverage,
    materials_sufficient: fullyMatched,
    requires_ai_completion: !fullyMatched,
    target_duration_seconds: session.target_duration_seconds,
    total_known_material_duration_seconds: Number(
      materialSegments
        .reduce((total, segment) => total + getSegmentFinalDuration(asJsonObject(segment)), 0)
        .toFixed(3)
    ),
    material_assets: baseCoverage.material_assets,
    slot_coverage: slotCoverage,
    matching_source: "refined_material_segments",
    summary: {
      slot_count: slotCoverage.length,
      fully_matched_count: slotCoverage.filter(
        (coverage) => coverage.frontend_coverage_status === "fully_matched"
      ).length,
      duration_short_count: slotCoverage.filter(
        (coverage) =>
          coverage.frontend_coverage_status === "structure_complete_duration_short"
      ).length,
      material_insufficient_count: slotCoverage.filter(
        (coverage) => coverage.frontend_coverage_status === "material_insufficient"
      ).length
    }
  };
};

const getCoverProductName = (session: V2ScriptSession): string => {
  return (
    normalizeOptionalString(session.user_request.product_name) ||
    normalizeOptionalString(session.user_request.target_product) ||
    normalizeOptionalString(session.user_request.target_topic) ||
    normalizeOptionalString(session.user_request.goal) ||
    "产品"
  );
};

const getCoverRecommendedSegment = (
  materialSegments: JsonObject[],
  slotCoverage: JsonObject[]
): JsonObject | undefined => {
  const assignedSegmentIds = new Set(
    slotCoverage.flatMap((coverage) =>
      Array.isArray(coverage.assigned_segments)
        ? coverage.assigned_segments
            .map(asJsonObject)
            .map((segment) => normalizeOptionalString(segment.segment_id))
            .filter((segmentId): segmentId is string => Boolean(segmentId))
        : []
    )
  );
  const candidateSegments = materialSegments
    .filter((segment) => {
      const frames = Array.isArray(segment.frames) ? segment.frames : [];
      return frames.length > 0;
    })
    .sort((left, right) => {
      const leftAssigned = assignedSegmentIds.has(String(left.segment_id)) ? 1 : 0;
      const rightAssigned = assignedSegmentIds.has(String(right.segment_id)) ? 1 : 0;
      if (leftAssigned !== rightAssigned) {
        return rightAssigned - leftAssigned;
      }

      return getNumber(right.quality_score, 0.5) - getNumber(left.quality_score, 0.5);
    });

  return candidateSegments[0];
};

const getCoverFrame = (segment: JsonObject | undefined): JsonObject | undefined => {
  const frames = Array.isArray(segment?.frames) ? segment.frames.map(asJsonObject) : [];
  if (frames.length === 0) {
    return undefined;
  }

  return frames[Math.floor(frames.length / 2)];
};

const buildV2CoverPlan = (
  session: V2ScriptSession,
  materialSegments: JsonObject[],
  segmentAwareMaterialCoverage: JsonObject
): JsonObject => {
  const productName = getCoverProductName(session);
  const goal =
    normalizeOptionalString(session.user_request.goal) ||
    `${productName}商业广告`;
  const slotCoverage = Array.isArray(segmentAwareMaterialCoverage.slot_coverage)
    ? segmentAwareMaterialCoverage.slot_coverage.map(asJsonObject)
    : [];
  const coverSegment = getCoverRecommendedSegment(materialSegments, slotCoverage);
  const coverFrame = getCoverFrame(coverSegment);
  const firstSlot = session.slots[0];
  const heroDescription =
    normalizeOptionalString(coverSegment?.content_summary) ||
    firstSlot?.shot_description ||
    `${productName}核心视觉特写`;
  const coverTitle =
    normalizeOptionalString(session.user_request.cover_title) ||
    `${productName}，一眼心动`;
  const coverSubtitle =
    normalizeOptionalString(session.user_request.cover_subtitle) ||
    normalizeOptionalString(session.user_request.target_audience) ||
    goal;
  const copyOptions = [
    coverTitle,
    `${productName}，现在就想试`,
    `${productName}高光时刻`,
    `这一刻，记住${productName}`
  ];

  return {
    cover_title: coverTitle,
    cover_subtitle: coverSubtitle,
    cover_copy_options: Array.from(new Set(copyOptions)).slice(0, 4),
    visual_direction: `${heroDescription}。画面应选择最能代表广告卖点的一帧，主体清晰，适合作为竖屏封面，顶部或中部预留标题空间。`,
    recommended_source: coverSegment
      ? {
          type: "material_segment",
          slot_id: coverSegment.assigned_slot_id,
          slot_type: coverSegment.assigned_slot_type,
          segment_id: coverSegment.segment_id,
          frame_id: coverFrame?.frame_id,
          frame_uri: coverFrame?.uri
        }
      : {
          type: "generated_cover_prompt"
        },
    cover_image_prompt: {
      prompt_ref: "cover_image_prompt",
      prompt_source: "deterministic_canvas_cover_plan",
      prompt: [
        `竖屏商业广告封面，主题是${productName}。`,
        `核心画面：${heroDescription}。`,
        "要求主体清晰、强视觉冲击、干净高对比、适合手机首屏浏览。",
        `封面主标题文案：${coverTitle}。`,
        "画面需要给标题文字预留空间，不要出现无关品牌、无关人物或杂乱背景。"
      ].join("\n")
    }
  };
};

export const buildV2ScriptMaterialSegments = async (
  session: V2ScriptSession
): Promise<JsonObject[]> => {
  const candidatePool = await buildV2MaterialCandidatePool({
    script_session: session,
    candidate_pool_id: `${session.session_id}_candidate_pool`,
    extract_frames: true
  });

  return Array.isArray(candidatePool.material_segments)
    ? candidatePool.material_segments.map((segment) => asJsonObject(segment))
    : [];
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
  const materialCandidatePool = await buildV2MaterialCandidatePool({
    script_session: session,
    candidate_pool_id:
      normalizeOptionalString(payload.candidate_pool_id) ||
      `${session.session_id}_canvas_candidate_pool`,
    extract_frames: payload.extract_frames !== false,
    refine_segments: payload.refine_segments !== false,
    use_multimodal_provider: payload.use_multimodal_provider !== false
  });
  const materialSegments = Array.isArray(materialCandidatePool.material_segments)
    ? materialCandidatePool.material_segments
    : [];
  const materialCoverage = await buildV2DeterministicMaterialCoverage(
    makeCoverageRequest(session, acceptedDurationShortSlots),
    makeCoverageArchitecture(session),
    makeCoverageMaterialAnalysis(session)
  );
  const segmentAwareMaterialCoverage = buildSegmentAwareMaterialCoverage(
    session,
    materialSegments.map(asJsonObject),
    materialCoverage as unknown as JsonObject,
    acceptedDurationShortSlots
  );
  const coverPlan = buildV2CoverPlan(
    session,
    materialSegments.map(asJsonObject),
    segmentAwareMaterialCoverage
  );

  const revalidateResult = {
    session_id: session.session_id,
    target_duration_seconds: session.target_duration_seconds,
    material_understanding_policy: {
      generated_structure_pacing: "user_request_first",
      source_material_pacing_is_authoritative: false,
      source_material_understanding:
        "uniform_high_frequency_candidate_frames_then_multimodal_refinement"
    },
    script_slots: session.slots,
    material_candidate_pool: materialCandidatePool,
    material_segments: materialSegments,
    material_coverage: segmentAwareMaterialCoverage,
    legacy_material_coverage: materialCoverage,
    cover_plan: coverPlan,
    canvas_nodes: (Array.isArray(segmentAwareMaterialCoverage.slot_coverage)
      ? segmentAwareMaterialCoverage.slot_coverage.map(asJsonObject)
      : []
    ).map((coverage, index) => ({
      slot_id: coverage.slot_id,
      slot_type: coverage.slot_type,
      script_order_index: index,
      display_order:
        session.slots.find((slot) => slot.slot_id === coverage.slot_id)?.display_order ??
        index + 1,
      label: coverage.frontend_coverage_label,
      coverage_status: coverage.frontend_coverage_status,
      required_duration: coverage.required_duration,
      matched_material_duration: coverage.matched_material_duration,
      missing_duration: coverage.missing_duration,
      needs_ai_completion: coverage.needs_ai_completion,
      recommended_video_prompt: coverage.recommended_video_prompt,
      recommended_aigc_prompt: coverage.recommended_aigc_prompt,
      available_generation_paths: coverage.available_generation_paths,
      direct_video_reference_materials: coverage.direct_video_reference_materials,
      assigned_segments: coverage.assigned_segments,
      matched_material_segments: coverage.matched_material_segments,
      candidate_material_segments: coverage.candidate_material_segments,
      matching_source: coverage.matching_source,
      semantic_matching_used: coverage.semantic_matching_used
    }))
  };
  const canvasSession =
    payload.persist_canvas_session === false
      ? undefined
      : createV2CanvasSessionFromRevalidateResult(revalidateResult);

  return {
    ...revalidateResult,
    canvas_session: canvasSession,
    canvas_session_id: canvasSession?.canvas_session_id
  };
};
