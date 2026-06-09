import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { storageConfig } from "../config/storage.js";
import { findUploadedVideoById } from "./uploadService.js";
import {
  assembleV2FinalVideo,
  generateV2ImageCandidates,
  generateV2ImageToVideo,
  reviewAndTrimV2GeneratedVideo,
  V2PipelineInputError
} from "./v2PipelineService.js";
import type { JsonObject } from "../v2/types.js";

export type V2CanvasNode = {
  node_id: string;
  node_type:
    | "script_slot"
    | "material_segment"
    | "missing_material"
    | "video_prompt"
    | "image_prompt"
    | "image_candidate"
    | "generated_video";
  slot_id?: string;
  segment_id?: string;
  display_order?: number;
  position?: JsonObject;
  data: JsonObject;
};

export type V2CanvasEdge = {
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type:
    | "sequence"
    | "fills_slot"
    | "has_gap"
    | "prompt_to_gap"
    | "image_to_gap"
    | "generated_video_to_gap";
  data?: JsonObject;
};

export type V2CanvasSession = {
  canvas_session_id: string;
  script_session_id: string;
  created_at: string;
  updated_at: string;
  target_duration_seconds: number;
  nodes: V2CanvasNode[];
  edges: V2CanvasEdge[];
  source: JsonObject;
};

const canvasSessionRootDir = path.join(storageConfig.outputDir, "v2-canvas-sessions");

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

const getNumber = (value: unknown, fallback = 0): number => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
};

const sanitizeId = (value: string): string => {
  const normalizedValue = value.replace(/[^a-zA-Z0-9_-]/gu, "");
  if (!normalizedValue) {
    throw new V2PipelineInputError("canvas_session_id is invalid");
  }

  return normalizedValue;
};

const ensureCanvasSessionDir = (): void => {
  fs.mkdirSync(canvasSessionRootDir, { recursive: true });
};

const getCanvasSessionPath = (canvasSessionId: string): string =>
  path.join(canvasSessionRootDir, `${sanitizeId(canvasSessionId)}.json`);

const saveCanvasSession = (session: V2CanvasSession): V2CanvasSession => {
  ensureCanvasSessionDir();
  fs.writeFileSync(
    getCanvasSessionPath(session.canvas_session_id),
    `${JSON.stringify(session, null, 2)}\n`
  );

  return session;
};

export const getV2CanvasSession = (canvasSessionId: string): V2CanvasSession => {
  const sessionPath = getCanvasSessionPath(canvasSessionId);
  if (!fs.existsSync(sessionPath)) {
    throw new V2PipelineInputError("canvas session not found", 404);
  }

  return JSON.parse(fs.readFileSync(sessionPath, "utf8")) as V2CanvasSession;
};

const makeNodeId = (...parts: string[]): string =>
  parts
    .map((part) => part.replace(/[^a-zA-Z0-9_-]/gu, "_"))
    .filter(Boolean)
    .join("_");

const getAssignedSegments = (coverage: JsonObject): JsonObject[] =>
  Array.isArray(coverage.assigned_segments)
    ? coverage.assigned_segments.map(asJsonObject)
    : [];

const buildInitialCanvasNodes = (
  slotCoverages: JsonObject[]
): V2CanvasNode[] => {
  const nodes: V2CanvasNode[] = [];

  for (const [index, coverage] of slotCoverages.entries()) {
    const slotId =
      normalizeOptionalString(coverage.slot_id) ||
      `slot_${String(index + 1).padStart(2, "0")}`;
    const slotNodeId = makeNodeId(slotId, "slot");
    nodes.push({
      node_id: slotNodeId,
      node_type: "script_slot",
      slot_id: slotId,
      display_order: getNumber(coverage.display_order, index + 1),
      data: coverage
    });

    for (const [segmentIndex, segment] of getAssignedSegments(coverage).entries()) {
      const segmentId =
        normalizeOptionalString(segment.segment_id) ||
        `${slotId}_segment_${String(segmentIndex + 1).padStart(2, "0")}`;
      nodes.push({
        node_id: makeNodeId(slotId, segmentId, "material"),
        node_type: "material_segment",
        slot_id: slotId,
        segment_id: segmentId,
        display_order: getNumber(coverage.display_order, index + 1),
        data: segment
      });
    }

    if (coverage.needs_ai_completion === true) {
      nodes.push({
        node_id: makeNodeId(slotId, "missing_material"),
        node_type: "missing_material",
        slot_id: slotId,
        display_order: getNumber(coverage.display_order, index + 1),
        data: {
          slot_id: slotId,
          slot_type: coverage.slot_type,
          required_duration: coverage.required_duration,
          matched_material_duration: coverage.matched_material_duration,
          missing_duration: coverage.missing_duration,
          raw_missing_duration: coverage.raw_missing_duration,
          ignored_missing_duration: coverage.ignored_missing_duration,
          coverage_status: coverage.frontend_coverage_status,
          gap_display: coverage.gap_display || {
            visible: true,
            title: "缺少必要素材，试试AI补齐吧！",
            missing_duration_seconds: coverage.missing_duration
          },
          recommended_video_prompt: coverage.recommended_video_prompt,
          recommended_aigc_prompt: coverage.recommended_aigc_prompt,
          prompt_ready: Boolean(
            normalizeOptionalString(asJsonObject(coverage.recommended_video_prompt).prompt) &&
              normalizeOptionalString(asJsonObject(coverage.recommended_aigc_prompt).prompt)
          ),
          available_generation_paths: coverage.available_generation_paths,
          direct_video_reference_materials: coverage.direct_video_reference_materials
        }
      });
    }
  }

  return nodes;
};

const buildInitialCanvasEdges = (
  slotCoverages: JsonObject[],
  nodes: V2CanvasNode[]
): V2CanvasEdge[] => {
  const edges: V2CanvasEdge[] = [];
  const slotNodes = nodes.filter((node) => node.node_type === "script_slot");

  for (let index = 0; index < slotNodes.length - 1; index += 1) {
    edges.push({
      edge_id: makeNodeId(slotNodes[index].node_id, "to", slotNodes[index + 1].node_id),
      source_node_id: slotNodes[index].node_id,
      target_node_id: slotNodes[index + 1].node_id,
      edge_type: "sequence"
    });
  }

  for (const coverage of slotCoverages) {
    const slotId = normalizeOptionalString(coverage.slot_id);
    if (!slotId) {
      continue;
    }

    const slotNodeId = makeNodeId(slotId, "slot");
    for (const segment of getAssignedSegments(coverage)) {
      const segmentId = normalizeOptionalString(segment.segment_id);
      if (!segmentId) {
        continue;
      }

      edges.push({
        edge_id: makeNodeId(slotId, segmentId, "fills"),
        source_node_id: makeNodeId(slotId, segmentId, "material"),
        target_node_id: slotNodeId,
        edge_type: "fills_slot"
      });
    }

    if (coverage.needs_ai_completion === true) {
      edges.push({
        edge_id: makeNodeId(slotId, "slot_has_gap"),
        source_node_id: slotNodeId,
        target_node_id: makeNodeId(slotId, "missing_material"),
        edge_type: "has_gap"
      });
    }
  }

  return edges;
};

export const createV2CanvasSessionFromRevalidateResult = (
  revalidateResult: JsonObject
): V2CanvasSession => {
  const materialCoverage = asJsonObject(revalidateResult.material_coverage);
  const slotCoverages = Array.isArray(materialCoverage.slot_coverage)
    ? materialCoverage.slot_coverage.map(asJsonObject)
    : [];
  const nodes = buildInitialCanvasNodes(slotCoverages);
  const edges = buildInitialCanvasEdges(slotCoverages, nodes);
  const now = new Date().toISOString();
  const session: V2CanvasSession = {
    canvas_session_id: `v2_canvas_${crypto.randomUUID()}`,
    script_session_id:
      normalizeOptionalString(revalidateResult.session_id) || "unknown_script_session",
    created_at: now,
    updated_at: now,
    target_duration_seconds: getNumber(revalidateResult.target_duration_seconds),
    nodes,
    edges,
    source: {
      type: "canvas_revalidate",
      material_candidate_pool_id: normalizeOptionalString(
        asJsonObject(revalidateResult.material_candidate_pool).candidate_pool_id
      ),
      matching_source: normalizeOptionalString(materialCoverage.matching_source),
      cover_plan: asJsonObject(revalidateResult.cover_plan)
    }
  };

  return saveCanvasSession(session);
};

const findNode = (
  session: V2CanvasSession,
  predicate: (node: V2CanvasNode) => boolean,
  message: string
): V2CanvasNode => {
  const node = session.nodes.find(predicate);
  if (!node) {
    throw new V2PipelineInputError(message, 404);
  }

  return node;
};

const findMissingNode = (session: V2CanvasSession, payload: JsonObject): V2CanvasNode => {
  const missingNodeId = normalizeOptionalString(payload.missing_node_id);
  const slotId = normalizeOptionalString(payload.slot_id);

  return findNode(
    session,
    (node) =>
      node.node_type === "missing_material" &&
      (missingNodeId ? node.node_id === missingNodeId : !slotId || node.slot_id === slotId),
    "missing material node not found"
  );
};

const upsertNode = (session: V2CanvasSession, nextNode: V2CanvasNode): V2CanvasNode => {
  const existingIndex = session.nodes.findIndex((node) => node.node_id === nextNode.node_id);
  if (existingIndex >= 0) {
    session.nodes[existingIndex] = nextNode;
  } else {
    session.nodes.push(nextNode);
  }

  return nextNode;
};

const upsertEdge = (session: V2CanvasSession, nextEdge: V2CanvasEdge): V2CanvasEdge => {
  const existingIndex = session.edges.findIndex((edge) => edge.edge_id === nextEdge.edge_id);
  if (existingIndex >= 0) {
    session.edges[existingIndex] = nextEdge;
  } else {
    session.edges.push(nextEdge);
  }

  return nextEdge;
};

const getPromptTextFromMissingNode = (
  missingNode: V2CanvasNode,
  promptType: "video" | "image"
): string | undefined => {
  const promptRecord = asJsonObject(
    promptType === "video"
      ? missingNode.data.recommended_video_prompt
      : missingNode.data.recommended_aigc_prompt
  );

  return normalizeOptionalString(promptRecord.prompt);
};

export const upsertV2CanvasPromptNode = (
  canvasSessionId: string,
  payload: JsonObject
): JsonObject => {
  const session = getV2CanvasSession(canvasSessionId);
  const missingNode = findMissingNode(session, payload);
  const promptType =
    normalizeOptionalString(payload.prompt_type) === "image" ? "image" : "video";
  const prompt =
    normalizeOptionalString(payload.prompt) ||
    getPromptTextFromMissingNode(missingNode, promptType);
  if (!prompt) {
    throw new V2PipelineInputError("prompt is required");
  }

  const nodeType = promptType === "image" ? "image_prompt" : "video_prompt";
  const promptNode = upsertNode(session, {
    node_id:
      normalizeOptionalString(payload.node_id) ||
      makeNodeId(missingNode.slot_id || "slot", promptType, "prompt"),
    node_type: nodeType,
    slot_id: missingNode.slot_id,
    display_order: missingNode.display_order,
    data: {
      prompt_type: promptType,
      prompt,
      original_recommended_prompt: getPromptTextFromMissingNode(missingNode, promptType),
      updated_at: new Date().toISOString()
    }
  });
  const edge = upsertEdge(session, {
    edge_id: makeNodeId(promptNode.node_id, "to", missingNode.node_id),
    source_node_id: promptNode.node_id,
    target_node_id: missingNode.node_id,
    edge_type: "prompt_to_gap"
  });
  session.updated_at = new Date().toISOString();
  saveCanvasSession(session);

  return {
    canvas_session: session,
    prompt_node: promptNode,
    edge
  };
};

const getPromptNodeForGap = (
  session: V2CanvasSession,
  missingNode: V2CanvasNode,
  nodeType: "video_prompt" | "image_prompt"
): V2CanvasNode | undefined => {
  for (const promptEdge of session.edges.filter(
    (edge) => edge.target_node_id === missingNode.node_id && edge.edge_type === "prompt_to_gap"
  )) {
    const promptNode = session.nodes.find(
      (node) => node.node_id === promptEdge.source_node_id && node.node_type === nodeType
    );
    if (promptNode) {
      return promptNode;
    }
  }

  return undefined;
};

export const generateV2CanvasImageCandidates = async (
  canvasSessionId: string,
  payload: JsonObject
): Promise<JsonObject> => {
  const session = getV2CanvasSession(canvasSessionId);
  const missingNode = findMissingNode(session, payload);
  const imagePromptNode = getPromptNodeForGap(session, missingNode, "image_prompt");
  const prompt =
    normalizeOptionalString(payload.prompt) ||
    normalizeOptionalString(imagePromptNode?.data.prompt) ||
    getPromptTextFromMissingNode(missingNode, "image");
  if (!prompt) {
    throw new V2PipelineInputError("image prompt is required");
  }

  const result = await generateV2ImageCandidates({
    prompt,
    count: getNumber(payload.count, 4),
    allow_fallback: payload.allow_fallback !== false,
    use_image_provider: payload.use_image_provider !== false
  });
  const rawCandidates = Array.isArray(result.candidates)
    ? result.candidates
    : Array.isArray(result.data)
      ? result.data
      : [];
  const imageCandidateNodes = rawCandidates.map((candidate, index): V2CanvasNode => {
    const record = asJsonObject(candidate);
    return upsertNode(session, {
      node_id: makeNodeId(
        missingNode.slot_id || "slot",
        "image_candidate",
        String(index + 1).padStart(2, "0")
      ),
      node_type: "image_candidate",
      slot_id: missingNode.slot_id,
      display_order: missingNode.display_order,
      data: {
        ...record,
        prompt,
        selected: false
      }
    });
  });

  session.updated_at = new Date().toISOString();
  saveCanvasSession(session);

  return {
    canvas_session: session,
    image_generation_result: result,
    image_candidate_nodes: imageCandidateNodes
  };
};

const getConnectedImageCandidateNode = (
  session: V2CanvasSession,
  missingNode: V2CanvasNode,
  payload: JsonObject
): V2CanvasNode | undefined => {
  const imageCandidateNodeId = normalizeOptionalString(payload.image_candidate_node_id);
  if (imageCandidateNodeId) {
    return session.nodes.find(
      (node) => node.node_id === imageCandidateNodeId && node.node_type === "image_candidate"
    );
  }

  const imageEdge = session.edges.find(
    (edge) => edge.target_node_id === missingNode.node_id && edge.edge_type === "image_to_gap"
  );
  if (!imageEdge) {
    return undefined;
  }

  return session.nodes.find(
    (node) => node.node_id === imageEdge.source_node_id && node.node_type === "image_candidate"
  );
};

const getSourceVideoUriForMissingNode = (missingNode: V2CanvasNode): string | undefined => {
  const refs = Array.isArray(missingNode.data.direct_video_reference_materials)
    ? missingNode.data.direct_video_reference_materials.map(asJsonObject)
    : [];
  for (const ref of refs) {
    const fileId = normalizeOptionalString(ref.file_id);
    const localPath = fileId ? findUploadedVideoById(fileId) : undefined;
    if (localPath) {
      return localPath;
    }

    const uri = normalizeOptionalString(ref.uri);
    if (uri && uri.startsWith("/") && fs.existsSync(uri)) {
      return uri;
    }
  }

  return undefined;
};

export const generateV2CanvasGapVideo = async (
  canvasSessionId: string,
  payload: JsonObject
): Promise<JsonObject> => {
  const session = getV2CanvasSession(canvasSessionId);
  const missingNode = findMissingNode(session, payload);
  const videoPromptNode = getPromptNodeForGap(session, missingNode, "video_prompt");
  const videoPrompt =
    normalizeOptionalString(payload.video_prompt) ||
    normalizeOptionalString(videoPromptNode?.data.prompt) ||
    getPromptTextFromMissingNode(missingNode, "video");
  if (!videoPrompt) {
    throw new V2PipelineInputError("video prompt is required");
  }

  const imageCandidateNode = getConnectedImageCandidateNode(session, missingNode, payload);
  const imageUri =
    normalizeOptionalString(payload.approved_image_uri) ||
    normalizeOptionalString(imageCandidateNode?.data.uri) ||
    normalizeOptionalString(imageCandidateNode?.data.url) ||
    normalizeOptionalString(imageCandidateNode?.data.image_url);
  const sourceVideoUri = imageUri ? undefined : getSourceVideoUriForMissingNode(missingNode);
  if (!imageUri && !sourceVideoUri) {
    throw new V2PipelineInputError(
      "gap video generation requires a connected image candidate or an existing material reference"
    );
  }

  const gapDurationSeconds =
    getNumber(payload.duration_seconds, getNumber(missingNode.data.missing_duration, 5)) || 5;
  const slotType = normalizeOptionalString(missingNode.data.slot_type);
  const slotDescription =
    normalizeOptionalString(missingNode.data.shot_description) ||
    normalizeOptionalString(missingNode.data.slot_description) ||
    normalizeOptionalString(missingNode.data.visual_description) ||
    normalizeOptionalString(missingNode.data.description);
  const generationResult = await generateV2ImageToVideo({
    video_prompt: videoPrompt,
    approved_image_uri: imageUri,
    source_video_uri: sourceVideoUri,
    duration_seconds: gapDurationSeconds,
    target_duration_seconds: gapDurationSeconds,
    slot_id: missingNode.slot_id,
    slot_type: slotType,
    slot_description: slotDescription,
    auto_trim_review: payload.auto_trim_review !== false,
    generation_mode: imageUri ? "generated_image" : "direct_from_material_frame",
    allow_fallback: payload.allow_fallback !== false,
    use_video_provider: payload.use_video_provider !== false
  });
  const generatedVideoNode = upsertNode(session, {
    node_id: makeNodeId(
      missingNode.slot_id || "slot",
      "generated_video",
      crypto.randomUUID()
    ),
    node_type: "generated_video",
    slot_id: missingNode.slot_id,
    display_order: missingNode.display_order,
    data: {
      video_prompt: videoPrompt,
      generation_mode: imageUri ? "generated_image" : "direct_from_material_frame",
      source_image_node_id: imageCandidateNode?.node_id,
      video_prompt_node_id: videoPromptNode?.node_id,
      missing_node_id: missingNode.node_id,
      missing_duration: gapDurationSeconds,
      target_duration_seconds: gapDurationSeconds,
      slot_type: slotType,
      slot_description: slotDescription,
      generation_result: generationResult,
      created_at: new Date().toISOString()
    }
  });
  const edge = upsertEdge(session, {
    edge_id: makeNodeId(generatedVideoNode.node_id, "to", missingNode.node_id),
    source_node_id: generatedVideoNode.node_id,
    target_node_id: missingNode.node_id,
    edge_type: "generated_video_to_gap"
  });
  session.updated_at = new Date().toISOString();
  saveCanvasSession(session);

  return {
    canvas_session: session,
    generated_video_node: generatedVideoNode,
    edge,
    generation_result: generationResult
  };
};

const getGeneratedVideoUri = (value: JsonObject): string | undefined => {
  const directUri =
    normalizeOptionalString(value.video_uri) ||
    normalizeOptionalString(value.video_url) ||
    normalizeOptionalString(value.url) ||
    normalizeOptionalString(value.output_video_url);
  if (directUri) {
    return directUri;
  }

  const data = asJsonObject(value.data);
  const nestedDirectUri =
    normalizeOptionalString(data.video_uri) ||
    normalizeOptionalString(data.video_url) ||
    normalizeOptionalString(data.url) ||
    normalizeOptionalString(data.output_video_url);
  if (nestedDirectUri) {
    return nestedDirectUri;
  }

  const generationResult = asJsonObject(value.generation_result);
  return (
    normalizeOptionalString(generationResult.video_uri) ||
    normalizeOptionalString(generationResult.video_url) ||
    normalizeOptionalString(generationResult.url) ||
    normalizeOptionalString(generationResult.output_video_url)
  );
};

const getGeneratedVideoNode = (
  session: V2CanvasSession,
  payload: JsonObject
): V2CanvasNode => {
  const generatedVideoNodeId = normalizeOptionalString(payload.generated_video_node_id);
  const slotId = normalizeOptionalString(payload.slot_id);

  return findNode(
    session,
    (node) =>
      node.node_type === "generated_video" &&
      (generatedVideoNodeId
        ? node.node_id === generatedVideoNodeId
        : !slotId || node.slot_id === slotId),
    "generated video node not found"
  );
};

const getMissingNodeForGeneratedVideo = (
  session: V2CanvasSession,
  generatedVideoNode: V2CanvasNode
): V2CanvasNode | undefined => {
  const gapEdge = session.edges.find(
    (edge) =>
      edge.source_node_id === generatedVideoNode.node_id &&
      edge.edge_type === "generated_video_to_gap"
  );
  if (!gapEdge) {
    return undefined;
  }

  return session.nodes.find(
    (node) => node.node_id === gapEdge.target_node_id && node.node_type === "missing_material"
  );
};

export const reviewAndTrimV2CanvasGeneratedVideo = async (
  canvasSessionId: string,
  payload: JsonObject
): Promise<JsonObject> => {
  const session = getV2CanvasSession(canvasSessionId);
  const generatedVideoNode = getGeneratedVideoNode(session, payload);
  const missingNode = getMissingNodeForGeneratedVideo(session, generatedVideoNode);
  const videoUri =
    normalizeOptionalString(payload.video_uri) || getGeneratedVideoUri(generatedVideoNode.data);

  if (!videoUri) {
    generatedVideoNode.data = {
      ...generatedVideoNode.data,
      trim_status: "pending_video_uri",
      trim_status_reason: "generated video task has not returned a video URI yet",
      updated_at: new Date().toISOString()
    };
    session.updated_at = new Date().toISOString();
    saveCanvasSession(session);

    return {
      canvas_session: session,
      generated_video_node: generatedVideoNode,
      trim_status: "pending_video_uri"
    };
  }

  const trimResult = await reviewAndTrimV2GeneratedVideo({
    video_uri: videoUri,
    slot_id: generatedVideoNode.slot_id,
    target_duration_seconds: getNumber(
      payload.target_duration_seconds,
      getNumber(missingNode?.data.missing_duration, 5)
    ),
    generation_prompt: normalizeOptionalString(generatedVideoNode.data.video_prompt),
    slot_description: normalizeOptionalString(missingNode?.data.slot_type),
    trim_video: payload.trim_video !== false,
    allow_fallback: payload.allow_fallback !== false,
    use_multimodal_provider: payload.use_multimodal_provider !== false
  });
  const trimmedVideoPath = normalizeOptionalString(trimResult.trimmed_video_path);
  const trimmedVideoUri = trimmedVideoPath
    ? `/api/v2/generation/trimmed-videos/${encodeURIComponent(path.basename(trimmedVideoPath))}`
    : undefined;
  generatedVideoNode.data = {
    ...generatedVideoNode.data,
    trim_status: "trimmed",
    trim_result: trimResult,
    usable_video_uri: trimmedVideoUri || videoUri,
    updated_at: new Date().toISOString()
  };
  session.updated_at = new Date().toISOString();
  saveCanvasSession(session);

  return {
    canvas_session: session,
    generated_video_node: generatedVideoNode,
    trim_result: trimResult,
    usable_video_uri: trimmedVideoUri || videoUri
  };
};

const getOrderedSlotNodes = (session: V2CanvasSession): V2CanvasNode[] => {
  const slotNodes = session.nodes.filter((node) => node.node_type === "script_slot");
  const slotNodeById = new Map(slotNodes.map((node) => [node.node_id, node]));
  const sequenceEdges = session.edges.filter((edge) => edge.edge_type === "sequence");
  const incomingSequenceTargets = new Set(sequenceEdges.map((edge) => edge.target_node_id));
  const firstSlotNode =
    slotNodes.find((node) => !incomingSequenceTargets.has(node.node_id)) || slotNodes[0];
  const orderedNodes: V2CanvasNode[] = [];
  const seen = new Set<string>();
  let currentNode: V2CanvasNode | undefined = firstSlotNode;

  while (currentNode && !seen.has(currentNode.node_id)) {
    const activeNode: V2CanvasNode = currentNode;
    orderedNodes.push(activeNode);
    seen.add(activeNode.node_id);
    const nextEdge: V2CanvasEdge | undefined = sequenceEdges.find(
      (edge) => edge.source_node_id === activeNode.node_id
    );
    currentNode = nextEdge ? slotNodeById.get(nextEdge.target_node_id) : undefined;
  }

  const missingNodes = slotNodes
    .filter((node) => !seen.has(node.node_id))
    .sort((left, right) => getNumber(left.display_order) - getNumber(right.display_order));

  return [...orderedNodes, ...missingNodes];
};

const getMaterialSegmentAssemblySlots = (
  session: V2CanvasSession,
  slotNode: V2CanvasNode
): JsonObject[] => {
  const materialEdges = session.edges.filter(
    (edge) => edge.target_node_id === slotNode.node_id && edge.edge_type === "fills_slot"
  );

  return materialEdges
    .map((edge) =>
      session.nodes.find(
        (node) => node.node_id === edge.source_node_id && node.node_type === "material_segment"
      )
    )
    .filter((node): node is V2CanvasNode => Boolean(node))
    .sort(
      (left, right) =>
        getNumber(left.data.source_in_seconds) - getNumber(right.data.source_in_seconds)
    )
    .map((node) => ({
      slot_id: slotNode.slot_id,
      slot_type: normalizeOptionalString(slotNode.data.slot_type),
      video_uri: node.data.uri,
      duration_seconds:
        getNumber(node.data.matched_material_duration) ||
        getNumber(node.data.usable_duration_seconds) ||
        getNumber(slotNode.data.required_duration),
      start_seconds: getNumber(node.data.source_in_seconds)
    }))
    .filter((slot) => normalizeOptionalString(slot.video_uri));
};

const getGeneratedVideoAssemblySlots = (
  session: V2CanvasSession,
  slotNode: V2CanvasNode
): JsonObject[] => {
  const missingEdges = session.edges.filter(
    (edge) => edge.source_node_id === slotNode.node_id && edge.edge_type === "has_gap"
  );
  const missingNodeIds = new Set(missingEdges.map((edge) => edge.target_node_id));
  const generatedEdges = session.edges.filter(
    (edge) =>
      missingNodeIds.has(edge.target_node_id) && edge.edge_type === "generated_video_to_gap"
  );

  return generatedEdges
    .map((edge) =>
      session.nodes.find(
        (node) => node.node_id === edge.source_node_id && node.node_type === "generated_video"
      )
    )
    .filter((node): node is V2CanvasNode => Boolean(node))
    .map((node) => {
      const trimResult = asJsonObject(node.data.trim_result);
      const trimRecommendation = asJsonObject(trimResult.trim_recommendation);
      return {
        slot_id: slotNode.slot_id,
        slot_type: normalizeOptionalString(slotNode.data.slot_type),
        video_uri:
          normalizeOptionalString(node.data.usable_video_uri) ||
          getGeneratedVideoUri(node.data),
        duration_seconds:
          getNumber(trimRecommendation.recommended_duration_seconds) ||
          getNumber(slotNode.data.missing_duration) ||
          getNumber(slotNode.data.required_duration),
        start_seconds: 0
      };
    })
    .filter((slot) => normalizeOptionalString(slot.video_uri));
};

export const assembleV2CanvasFinalVideo = async (
  canvasSessionId: string,
  payload: JsonObject
): Promise<JsonObject> => {
  const session = getV2CanvasSession(canvasSessionId);
  const assemblySlots = getOrderedSlotNodes(session).flatMap((slotNode) => [
    ...getMaterialSegmentAssemblySlots(session, slotNode),
    ...getGeneratedVideoAssemblySlots(session, slotNode)
  ]);
  if (assemblySlots.length === 0) {
    throw new V2PipelineInputError("canvas session has no connected video nodes to assemble");
  }

  const result = await assembleV2FinalVideo({
    slots: assemblySlots.map((slot) => ({
      slot_id: normalizeOptionalString(slot.slot_id),
      slot_type: normalizeOptionalString(slot.slot_type),
      video_uri: normalizeOptionalString(slot.video_uri) || "",
      duration_seconds: getNumber(slot.duration_seconds),
      start_seconds: getNumber(slot.start_seconds)
    })),
    target_duration_seconds:
      payload.target_duration_seconds === undefined
        ? undefined
        : getNumber(payload.target_duration_seconds),
    resolution: normalizeOptionalString(payload.resolution),
    fps: payload.fps === undefined ? undefined : getNumber(payload.fps),
    background_color: normalizeOptionalString(payload.background_color),
    allow_loop_short_clips: payload.allow_loop_short_clips !== false
  });

  session.source = {
    ...session.source,
    last_assembly_id: result.assembly_id,
    last_final_video_url: result.final_video_url,
    last_assembled_at: new Date().toISOString()
  };
  session.updated_at = new Date().toISOString();
  saveCanvasSession(session);

  return {
    canvas_session: session,
    assembly_slots: assemblySlots,
    cover_plan: asJsonObject(session.source.cover_plan),
    final_assembly: result
  };
};

const normalizeCanvasNode = (value: unknown): V2CanvasNode => {
  const node = asJsonObject(value);
  const nodeId = normalizeOptionalString(node.node_id);
  const nodeType = normalizeOptionalString(node.node_type) as V2CanvasNode["node_type"];
  if (!nodeId || !nodeType) {
    throw new V2PipelineInputError("canvas nodes require node_id and node_type");
  }

  return {
    node_id: nodeId,
    node_type: nodeType,
    slot_id: normalizeOptionalString(node.slot_id),
    segment_id: normalizeOptionalString(node.segment_id),
    display_order:
      node.display_order === undefined ? undefined : getNumber(node.display_order),
    position: asJsonObject(node.position),
    data: asJsonObject(node.data)
  };
};

const normalizeCanvasEdge = (value: unknown): V2CanvasEdge => {
  const edge = asJsonObject(value);
  const edgeId = normalizeOptionalString(edge.edge_id);
  const sourceNodeId = normalizeOptionalString(edge.source_node_id);
  const targetNodeId = normalizeOptionalString(edge.target_node_id);
  const edgeType = normalizeOptionalString(edge.edge_type) as V2CanvasEdge["edge_type"];
  if (!edgeId || !sourceNodeId || !targetNodeId || !edgeType) {
    throw new V2PipelineInputError(
      "canvas edges require edge_id, source_node_id, target_node_id and edge_type"
    );
  }

  return {
    edge_id: edgeId,
    source_node_id: sourceNodeId,
    target_node_id: targetNodeId,
    edge_type: edgeType,
    data: asJsonObject(edge.data)
  };
};

export const updateV2CanvasSession = (
  canvasSessionId: string,
  payload: JsonObject
): V2CanvasSession => {
  const session = getV2CanvasSession(canvasSessionId);

  if (Array.isArray(payload.nodes)) {
    session.nodes = payload.nodes.map(normalizeCanvasNode);
  }

  if (Array.isArray(payload.edges)) {
    session.edges = payload.edges.map(normalizeCanvasEdge);
  }

  session.updated_at = new Date().toISOString();
  return saveCanvasSession(session);
};
