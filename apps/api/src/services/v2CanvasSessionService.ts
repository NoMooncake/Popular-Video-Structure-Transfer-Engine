import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { storageConfig } from "../config/storage.js";
import { V2PipelineInputError } from "./v2PipelineService.js";
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
          coverage_status: coverage.frontend_coverage_status,
          recommended_video_prompt: coverage.recommended_video_prompt,
          recommended_aigc_prompt: coverage.recommended_aigc_prompt,
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
      matching_source: normalizeOptionalString(materialCoverage.matching_source)
    }
  };

  return saveCanvasSession(session);
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
