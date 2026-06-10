import { useEffect, useMemo, useRef, useState } from "react";
import {
  generateV2CanvasGapVideo,
  generateV2CanvasImageCandidates
} from "../api/client";
import type { V2CanvasNode, V2CanvasSession } from "../api/client";
import type { CanvasBlock, V2MaterialAssignment, V2MaterialCoverageSlot } from "../types";

type VideoBlockCanvasProps = {
  blocks: CanvasBlock[];
  canvasSession?: V2CanvasSession;
  canvasSessionId?: string;
  selectedBlockId: string;
  onCanvasSessionChange?: (canvasSession: V2CanvasSession) => void;
  onSelectBlock: (blockId: string) => void;
  onUpdateBlock: (updatedBlock: CanvasBlock) => void;
  onBack?: () => void;
  onExport?: () => void;
  onHome?: () => void;
  projectName?: string;
};

type CanvasPosition = {
  x: number;
  y: number;
};

type CanvasStatus = "matched" | "missing" | "duration_insufficient" | "generating";

type VideoGenerationPayload = {
  keyframe_image?: string;
  source_video_uri?: string;
  video_prompt: string;
};

const BASE_CANVAS_WIDTH = 2360;
const BASE_CANVAS_HEIGHT = 980;
const MIN_ZOOM = 25;
const MAX_ZOOM = 200;
const ZOOM_STEP = 10;
const DRAG_THRESHOLD = 4;

const cardImages = [
  "https://www.figma.com/api/mcp/asset/7a9bb822-f69c-4344-9da9-27ec440b9d2e",
  "https://www.figma.com/api/mcp/asset/45d15bc2-c541-433f-9c4c-2a1db76e627d",
  "https://www.figma.com/api/mcp/asset/27f882c5-4b54-4e3e-b9b7-811c7dfe6429"
];

const figmaLabels = ["Hook", "产品介入", "感官特写", "使用动作", "使用动作", "行动引导"];

const fallbackPositions = (blocks: CanvasBlock[]) =>
  blocks.reduce<Record<string, CanvasPosition>>((positions, block, index) => {
    positions[block.id] = {
      x: 204 + index * 362,
      y: 341
    };
    return positions;
  }, {});

const labelForBlock = (block: CanvasBlock, index: number) =>
  figmaLabels[index] ?? block.slot.slot_type ?? block.label;

const imageForBlock = (block: CanvasBlock, index: number) =>
  block.v2?.coverageSlot?.direct_video_reference_materials?.[0]?.uri ??
  cardImages[index % cardImages.length];

const getBlockMaterialAssignments = (block: CanvasBlock): V2MaterialAssignment[] => {
  const slot = block.v2?.coverageSlot;
  if (!slot) {
    return [];
  }

  const seen = new Set<string>();
  return [
    ...(slot.assigned_segments ?? []),
    ...(slot.matched_material_segments ?? []),
    ...(slot.assigned_materials ?? [])
  ].filter((material) => {
    const key = [
      material.segment_id,
      material.material_id,
      material.source_material_id,
      material.file_id,
      material.uri,
      material.source_in_seconds,
      material.source_out_seconds
    ].join(":");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const hasMaterialSegment = (block: CanvasBlock) =>
  getBlockMaterialAssignments(block).some((material) => {
    const start = material.source_in_seconds ?? material.start_seconds;
    const end = material.source_out_seconds ?? material.end_seconds;
    return (
      Boolean(material.time_range) ||
      (typeof start === "number" && typeof end === "number" && end > start) ||
      (typeof material.matched_material_duration === "number" &&
        material.matched_material_duration > 0)
    );
  });

const frameUriFromMaterial = (material: V2MaterialAssignment): string | undefined => {
  const frames = material.frames ?? [];
  for (const frame of frames) {
    const uri = frame.uri || frame.image_uri || frame.public_uri || frame.media?.uri;
    if (uri) {
      return uri;
    }
  }

  return undefined;
};

const materialImageForBlock = (block: CanvasBlock): string | undefined => {
  for (const material of getBlockMaterialAssignments(block)) {
    const frameUri = frameUriFromMaterial(material);
    if (frameUri) {
      return frameUri;
    }
  }

  return undefined;
};

const browserPlayableUri = (uri: string | undefined): string | undefined => {
  if (!uri) {
    return undefined;
  }

  if (/^(?:https?:|blob:|data:)/iu.test(uri) || uri.startsWith("/api/")) {
    return uri;
  }

  return undefined;
};

const materialVideoForBlock = (block: CanvasBlock): string | undefined => {
  for (const material of getBlockMaterialAssignments(block)) {
    const uri = browserPlayableUri(material.uri);
    if (uri) {
      return uri;
    }

    if (material.file_id) {
      return `/api/upload/files/${encodeURIComponent(material.file_id)}`;
    }
  }

  return undefined;
};

const portColorByStatus: Record<CanvasStatus, "matched" | "missing"> = {
  matched: "matched",
  missing: "missing",
  duration_insufficient: "missing",
  generating: "missing"
};

const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

const defaultKeyframePromptFor = (block: CanvasBlock, index: number) =>
  `请生成一幅画面，展示${labelForBlock(
    block,
    index
  )}的场景，突出产品如何改变环境或提升用户体验。画面应充满活力，能够吸引观众的注意力。`;

const defaultVideoPromptFor = (block: CanvasBlock, index: number) =>
  block.timeline?.visual_description
    ? `在这个视频中，我们将围绕“${labelForBlock(block, index)}”补充一段画面。${block.timeline.visual_description} 请保持与前后镜头一致的光线、节奏和产品呈现方式。`
    : `在这个视频中，我们将深入探讨“${labelForBlock(
        block,
        index
      )}”的重要性。我们的产品具有清晰的卖点和自然的使用场景，画面需要承接前后镜头，突出产品如何提升用户体验，并保持广告整体节奏连贯。`;

const formatSeconds = (value?: number) => {
  const seconds = Number(value ?? 0);
  return `${Number.isFinite(seconds) ? seconds.toFixed(seconds % 1 === 0 ? 0 : 1) : "0"}s`;
};

const suggestionsForBlock = (block: CanvasBlock) =>
  block.v2?.coverageSlot?.available_user_actions?.length
    ? block.v2.coverageSlot.available_user_actions
    : block.status === "partial"
      ? ["补拍素材", "放慢节奏", "AI 补全过渡镜头", "压缩原结构"]
      : ["补充产品特写", "补充使用场景", "使用 AI 生成补全"];

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const getStringField = (record: Record<string, unknown>, fields: string[]) => {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return undefined;
};

const getNumberField = (
  record: Record<string, unknown> | undefined,
  fields: string[],
  fallback = 0
) => {
  if (!record) {
    return fallback;
  }

  for (const field of fields) {
    const value = record[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return fallback;
};

const extractImageCandidateUris = (response: unknown): string[] => {
  const record = asRecord(response);
  const items = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.images)
      ? record.images
      : [];

  return items
    .map((item) => getStringField(asRecord(item), ["uri", "url", "image_url"]))
    .filter((uri): uri is string => Boolean(uri));
};

const extractGeneratedVideoUri = (response: unknown): string | undefined => {
  const record = asRecord(response);
  const output = asRecord(record.output);
  const data = asRecord(record.data);
  const content = asRecord(record.content);

  return (
    getStringField(record, ["usable_video_uri", "final_video_url", "trimmed_video_url", "video_uri", "uri", "url", "video_url"]) ||
    getStringField(output, ["usable_video_uri", "final_video_url", "trimmed_video_url", "video_uri", "uri", "url", "video_url"]) ||
    getStringField(data, ["usable_video_uri", "final_video_url", "trimmed_video_url", "video_uri", "uri", "url", "video_url"]) ||
    getStringField(content, ["usable_video_uri", "final_video_url", "trimmed_video_url", "video_uri", "uri", "url", "video_url"])
  );
};

const hasCanvasSession = (response: unknown): response is { canvas_session: V2CanvasSession } =>
  Boolean(asRecord(response).canvas_session);

const getImageGenerationPayload = (response: unknown): unknown => {
  const record = asRecord(response);
  return record.image_generation_result ?? response;
};

const getVideoGenerationPayload = (response: unknown): unknown => {
  const record = asRecord(response);
  return record.generation_result ?? response;
};

const getBackendSlotId = (block: CanvasBlock): string =>
  block.v2?.coverageSlot?.slot_id || block.v2?.parentSlotId || block.slot.slot_id || block.id;

const getMissingNodeId = (block: CanvasBlock): string | undefined =>
  block.v2?.displayKind === "missing_material" ? block.v2.canvasNodeId : undefined;

const toMaterialAssignment = (node: V2CanvasNode): V2MaterialAssignment => {
  const data = node.data as V2MaterialAssignment;
  return {
    ...data,
    segment_id: data.segment_id || node.segment_id,
    source_material_id: data.source_material_id || data.material_id,
    label: data.label || node.segment_id || node.node_id
  };
};

const compareCanvasNodes = (first: V2CanvasNode, second: V2CanvasNode): number => {
  const firstOrder = getNumberField(first.data, ["display_order", "order"], first.display_order ?? 0);
  const secondOrder = getNumberField(second.data, ["display_order", "order"], second.display_order ?? 0);
  if (firstOrder !== secondOrder) {
    return firstOrder - secondOrder;
  }

  const firstStart = getNumberField(first.data, [
    "slot_start_seconds",
    "target_start_seconds",
    "start_seconds"
  ]);
  const secondStart = getNumberField(second.data, [
    "slot_start_seconds",
    "target_start_seconds",
    "start_seconds"
  ]);
  if (firstStart !== secondStart) {
    return firstStart - secondStart;
  }

  if (first.node_type !== second.node_type) {
    return first.node_type === "material_segment" ? -1 : 1;
  }

  const firstSourceStart = getNumberField(first.data, [
    "source_in_seconds",
    "final_source_in_seconds"
  ]);
  const secondSourceStart = getNumberField(second.data, [
    "source_in_seconds",
    "final_source_in_seconds"
  ]);
  if (firstSourceStart !== secondSourceStart) {
    return firstSourceStart - secondSourceStart;
  }

  return first.node_id.localeCompare(second.node_id);
};

const withMaterialOnlyCoverage = (
  coverageSlot: V2MaterialCoverageSlot | undefined,
  material: V2MaterialAssignment
): V2MaterialCoverageSlot | undefined => {
  if (!coverageSlot) {
    return undefined;
  }

  const duration =
    material.matched_material_duration ??
    material.duration_seconds ??
    material.usable_duration_seconds ??
    coverageSlot.matched_material_duration;

  return {
    ...coverageSlot,
    ai_completion_required_duration: 0,
    assigned_materials: [material],
    assigned_segments: [material],
    coverage_status: "covered",
    frontend_coverage_status: "fully_matched",
    matched_material_duration: duration,
    matched_material_segments: [material],
    missing_duration: 0,
    needs_ai_completion: false
  };
};

const withMissingOnlyCoverage = (
  coverageSlot: V2MaterialCoverageSlot | undefined,
  missingNode: V2CanvasNode
): V2MaterialCoverageSlot | undefined => {
  if (!coverageSlot) {
    return undefined;
  }

  const missingDuration = getNumberField(
    missingNode.data,
    ["missing_duration", "missing_duration_seconds", "required_duration"],
    coverageSlot.missing_duration || coverageSlot.ai_completion_required_duration || coverageSlot.required_duration
  );

  return {
    ...coverageSlot,
    ai_completion_required_duration: missingDuration,
    assigned_materials: [],
    assigned_segments: [],
    coverage_status: "missing",
    direct_video_reference_materials:
      (missingNode.data.direct_video_reference_materials as V2MaterialCoverageSlot["direct_video_reference_materials"]) ??
      coverageSlot.direct_video_reference_materials,
    frontend_coverage_status: "material_insufficient",
    gap_reason:
      getStringField(missingNode.data, ["gap_reason", "missing", "reason"]) ||
      coverageSlot.gap_reason,
    matched_material_duration: 0,
    matched_material_segments: [],
    missing_duration: missingDuration,
    needs_ai_completion: true,
    recommended_aigc_prompt:
      (missingNode.data.recommended_aigc_prompt as V2MaterialCoverageSlot["recommended_aigc_prompt"]) ??
      coverageSlot.recommended_aigc_prompt,
    recommended_video_prompt:
      (missingNode.data.recommended_video_prompt as V2MaterialCoverageSlot["recommended_video_prompt"]) ??
      coverageSlot.recommended_video_prompt
  };
};

const materialBlockFromNode = (
  baseBlock: CanvasBlock,
  node: V2CanvasNode,
  slotId: string
): CanvasBlock => {
  const material = toMaterialAssignment(node);
  const coverageSlot = withMaterialOnlyCoverage(baseBlock.v2?.coverageSlot, material);

  return {
    ...baseBlock,
    id: node.node_id,
    materialSummary:
      material.visual_description ||
      material.content_summary ||
      baseBlock.materialSummary,
    status: "matched",
    v2: {
      ...baseBlock.v2,
      canvasNodeId: node.node_id,
      coverageSlot,
      displayKind: "material_segment",
      parentSlotId: slotId
    }
  };
};

const missingBlockFromNode = (
  baseBlock: CanvasBlock,
  node: V2CanvasNode,
  slotId: string
): CanvasBlock => {
  const coverageSlot = withMissingOnlyCoverage(baseBlock.v2?.coverageSlot, node);
  const missing =
    coverageSlot?.gap_reason ||
    getStringField(node.data, ["missing", "gap_reason", "reason"]) ||
    baseBlock.gap?.missing ||
    baseBlock.materialSummary;

  return {
    ...baseBlock,
    id: node.node_id,
    gap: {
      gap_id: `${slotId}_${node.node_id}_gap`,
      slot_id: slotId,
      slot_type: baseBlock.slot.slot_type,
      missing,
      impact: coverageSlot?.recommended_video_prompt?.prompt_description || baseBlock.gap?.impact || missing,
      severity: "high",
      strategy:
        coverageSlot?.recommended_video_prompt?.prompt ||
        coverageSlot?.recommended_aigc_prompt?.prompt ||
        baseBlock.gap?.strategy ||
        missing,
      fill_options: baseBlock.gap?.fill_options ?? []
    },
    materialSummary: missing,
    status: "missing",
    v2: {
      ...baseBlock.v2,
      canvasNodeId: node.node_id,
      coverageSlot,
      displayKind: "missing_material",
      parentSlotId: slotId
    }
  };
};

const createCanvasDisplayBlocks = (
  blocks: CanvasBlock[],
  canvasSession?: V2CanvasSession
): CanvasBlock[] => {
  if (!canvasSession?.nodes?.length) {
    return blocks;
  }

  const nodesById = new Map(canvasSession.nodes.map((node) => [node.node_id, node]));
  const blocksBySlotId = new Map(blocks.map((block) => [getBackendSlotId(block), block]));
  const slotNodes = canvasSession.nodes
    .filter((node) => node.node_type === "script_slot")
    .sort(compareCanvasNodes);

  if (!slotNodes.length) {
    return blocks;
  }

  const displayBlocks: CanvasBlock[] = [];
  const consumedSlotIds = new Set<string>();

  for (const slotNode of slotNodes) {
    const slotId = slotNode.slot_id || getStringField(slotNode.data, ["slot_id"]);
    if (!slotId) {
      continue;
    }

    const baseBlock = blocksBySlotId.get(slotId);
    if (!baseBlock) {
      continue;
    }

    consumedSlotIds.add(slotId);
    const materialNodes = canvasSession.edges
      .filter(
        (edge) => edge.edge_type === "fills_slot" && edge.target_node_id === slotNode.node_id
      )
      .map((edge) => nodesById.get(edge.source_node_id))
      .filter((node): node is V2CanvasNode => node?.node_type === "material_segment")
      .sort(compareCanvasNodes);
    const missingNodes = canvasSession.edges
      .filter(
        (edge) => edge.edge_type === "has_gap" && edge.source_node_id === slotNode.node_id
      )
      .map((edge) => nodesById.get(edge.target_node_id))
      .filter((node): node is V2CanvasNode => node?.node_type === "missing_material")
      .sort(compareCanvasNodes);

    const childBlocks = [
      ...materialNodes.map((node) => materialBlockFromNode(baseBlock, node, slotId)),
      ...missingNodes.map((node) => missingBlockFromNode(baseBlock, node, slotId))
    ].sort((first, second) => {
      const firstNode = first.v2?.canvasNodeId ? nodesById.get(first.v2.canvasNodeId) : undefined;
      const secondNode = second.v2?.canvasNodeId ? nodesById.get(second.v2.canvasNodeId) : undefined;
      return firstNode && secondNode ? compareCanvasNodes(firstNode, secondNode) : 0;
    });

    displayBlocks.push(...(childBlocks.length ? childBlocks : [baseBlock]));
  }

  for (const block of blocks) {
    if (!consumedSlotIds.has(getBackendSlotId(block))) {
      displayBlocks.push(block);
    }
  }

  return displayBlocks.length ? displayBlocks : blocks;
};

export const VideoBlockCanvas = ({
  blocks,
  canvasSession,
  canvasSessionId,
  selectedBlockId,
  onCanvasSessionChange,
  onSelectBlock,
  onUpdateBlock,
  onBack,
  onExport,
  onHome,
  projectName = "口红广告"
}: VideoBlockCanvasProps) => {
  const displayBlocks = useMemo(
    () => createCanvasDisplayBlocks(blocks, canvasSession),
    [blocks, canvasSession]
  );
  const basePositions = useMemo(() => fallbackPositions(displayBlocks), [displayBlocks]);
  const [positions, setPositions] = useState<Record<string, CanvasPosition>>(basePositions);
  const [isDragging, setIsDragging] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [zoomDraft, setZoomDraft] = useState("100");
  const [showHelp, setShowHelp] = useState(false);
  const [activeEditorBlockId, setActiveEditorBlockId] = useState<string | null>(null);
  const [keyframeLoadingBlockId, setKeyframeLoadingBlockId] = useState<string | null>(null);
  const [generatingVideoBlockId, setGeneratingVideoBlockId] = useState<string | null>(null);
  const [selectorBlockId, setSelectorBlockId] = useState<string | null>(null);
  const [selectedCandidateUrl, setSelectedCandidateUrl] = useState<string | null>(null);
  const [playbackBlockId, setPlaybackBlockId] = useState<string | null>(null);
  const [keyframePrompts, setKeyframePrompts] = useState<Record<string, string>>({});
  const [videoPrompts, setVideoPrompts] = useState<Record<string, string>>({});
  const [keyframeCandidates, setKeyframeCandidates] = useState<Record<string, string[]>>({});
  const [selectedKeyframes, setSelectedKeyframes] = useState<Record<string, string>>({});
  const [generatedVideoThumbs, setGeneratedVideoThumbs] = useState<Record<string, string>>({});
  const [generatedVideoUris, setGeneratedVideoUris] = useState<Record<string, string>>({});
  const [selectedCanvasBlockId, setSelectedCanvasBlockId] = useState<string | null>(null);
  const blockOrderKey = useMemo(() => displayBlocks.map((block) => block.id).join("|"), [displayBlocks]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    blockId: string;
    didMove: boolean;
    startedOnPlay: boolean;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
  } | null>(null);
  const panRef = useRef<{
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  useEffect(() => {
    setPositions(fallbackPositions(displayBlocks));
    setActiveEditorBlockId(null);
    onSelectBlock("");
  }, [blockOrderKey]);

  const selectedBlock =
    displayBlocks.find((block) => block.id === selectedCanvasBlockId) ??
    displayBlocks.find((block) => block.id === selectedBlockId) ??
    displayBlocks.find((block) => getBackendSlotId(block) === selectedBlockId) ??
    displayBlocks[0];

  useEffect(() => {
    if (!selectedCanvasBlockId) {
      return;
    }
    if (!displayBlocks.some((block) => block.id === selectedCanvasBlockId)) {
      setSelectedCanvasBlockId(null);
    }
  }, [displayBlocks, selectedCanvasBlockId]);

  const getCanvasStatus = (block: CanvasBlock, index: number): CanvasStatus => {
    if (generatingVideoBlockId === block.id) {
      return "generating";
    }

    if (generatedVideoUris[block.id] || generatedVideoThumbs[block.id]) {
      return "matched";
    }

    if (block.status === "matched") {
      return "matched";
    }

    if (block.status === "partial" || hasMaterialSegment(block)) {
      return "duration_insufficient";
    }

    return "missing";
  };

  const needsCompletion = (block: CanvasBlock, index: number) =>
    getCanvasStatus(block, index) !== "matched";

  const statusTextFor = (status: CanvasStatus, aiCompleted: boolean) => {
    if (status === "generating") {
      return "生成中";
    }

    if (aiCompleted) {
      return "AI已生成";
    }

    if (status === "matched") {
      return "已完成";
    }

    if (status === "missing") {
      return "缺必要输入";
    }

    return "时长不足";
  };

  const getKeyframePrompt = (block: CanvasBlock, index: number) =>
    keyframePrompts[block.id] ??
    block.v2?.coverageSlot?.recommended_aigc_prompt?.prompt ??
    defaultKeyframePromptFor(block, index);

  const getVideoPrompt = (block: CanvasBlock, index: number) =>
    videoPrompts[block.id] ??
    block.v2?.coverageSlot?.recommended_video_prompt?.prompt ??
    defaultVideoPromptFor(block, index);

  const applyZoom = (
    nextZoom: number,
    anchor?: {
      clientX: number;
      clientY: number;
    }
  ) => {
    const container = scrollRef.current;
    const next = clampZoom(Math.round(nextZoom));
    const previousScale = zoom / 100;
    const nextScale = next / 100;

    let anchorCanvasX: number | null = null;
    let anchorCanvasY: number | null = null;
    let offsetX = 0;
    let offsetY = 0;

    if (container && anchor) {
      const rect = container.getBoundingClientRect();
      offsetX = anchor.clientX - rect.left;
      offsetY = anchor.clientY - rect.top;
      anchorCanvasX = (container.scrollLeft + offsetX) / previousScale;
      anchorCanvasY = (container.scrollTop + offsetY) / previousScale;
    }

    setZoom(next);
    setZoomDraft(String(next));

    if (container && anchorCanvasX !== null && anchorCanvasY !== null) {
      window.requestAnimationFrame(() => {
        container.scrollLeft = anchorCanvasX * nextScale - offsetX;
        container.scrollTop = anchorCanvasY * nextScale - offsetY;
      });
    }
  };

  const commitZoomDraft = () => {
    const next = Number.parseInt(zoomDraft, 10);
    if (Number.isFinite(next)) {
      applyZoom(next);
      return;
    }
    setZoomDraft(String(zoom));
  };

  const resetViewport = () => {
    setPositions(basePositions);
    applyZoom(100);
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest(".figma-zoom-control")) {
      return;
    }

    event.preventDefault();
    const direction = event.deltaY > 0 ? -1 : 1;
    applyZoom(zoom + direction * ZOOM_STEP, {
      clientX: event.clientX,
      clientY: event.clientY
    });
  };

  const handleCanvasPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (
      target.closest(
        ".figma-structure-card, .figma-gap-editor, .figma-canvas-tools, .figma-help-popover, .figma-ai-modal, .figma-zoom-control, button, input, textarea"
      )
    ) {
      return;
    }

    setActiveEditorBlockId(null);
    onSelectBlock("");
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    panRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop
    };
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleCanvasPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!panRef.current || !scrollRef.current) {
      return;
    }

    scrollRef.current.scrollLeft =
      panRef.current.scrollLeft - (event.clientX - panRef.current.startX);
    scrollRef.current.scrollTop =
      panRef.current.scrollTop - (event.clientY - panRef.current.startY);
  };

  const handleCanvasPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!panRef.current) {
      return;
    }

    panRef.current = null;
    setIsPanning(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>, blockId: string) => {
    const target = event.target as HTMLElement;
    const startedOnPlay = Boolean(target.closest(".figma-play-overlay"));
    if (target.closest("button:not(.figma-play-overlay), input, textarea")) {
      return;
    }

    event.stopPropagation();
    const block = displayBlocks.find((item) => item.id === blockId);
    setSelectedCanvasBlockId(blockId);
    onSelectBlock(block ? getBackendSlotId(block) : blockId);

    const current = positions[blockId] ?? basePositions[blockId] ?? { x: 0, y: 0 };
    dragRef.current = {
      blockId,
      didMove: false,
      startedOnPlay,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: current.x,
      startTop: current.y
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!dragRef.current) {
      return;
    }

    const { blockId, startX, startY, startLeft, startTop } = dragRef.current;
    const scale = zoom / 100;
    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;

    if (!dragRef.current.didMove && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) {
      return;
    }

    dragRef.current.didMove = true;
    if (!isDragging) {
      setIsDragging(true);
    }

    const nextX = Math.max(24, startLeft + deltaX / scale);
    const nextY = Math.max(130, startTop + deltaY / scale);

    setPositions((current) => ({
      ...current,
      [blockId]: {
        x: nextX,
        y: nextY
      }
    }));
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLElement>) => {
    if (!dragRef.current) {
      return;
    }

    const { blockId, didMove, startedOnPlay } = dragRef.current;
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setIsDragging(false);

    if (didMove) {
      return;
    }

    const blockIndex = displayBlocks.findIndex((item) => item.id === blockId);
    const block = displayBlocks[blockIndex];
    setSelectedCanvasBlockId(blockId);
    onSelectBlock(block ? getBackendSlotId(block) : blockId);
    if (startedOnPlay) {
      setActiveEditorBlockId(null);
      setPlaybackBlockId(blockId);
      return;
    }

    const status = block ? getCanvasStatus(block, blockIndex) : null;
    const canEdit =
      block &&
      status !== "generating" &&
      needsCompletion(block, blockIndex);

    setActiveEditorBlockId(canEdit ? blockId : null);
  };

  const generateKeyframeCandidates = async (blockId: string) => {
    setActiveEditorBlockId(blockId);
    setKeyframeLoadingBlockId(blockId);
    setSelectedCandidateUrl(null);

    const blockIndex = displayBlocks.findIndex((block) => block.id === blockId);
    const block = displayBlocks[blockIndex];
    if (!block) {
      setKeyframeLoadingBlockId(null);
      return;
    }

    try {
      const prompt =
        block.v2?.coverageSlot?.recommended_aigc_prompt?.prompt ??
        getKeyframePrompt(block, blockIndex);
      if (!canvasSessionId) {
        throw new Error("V2 canvas session is required for image generation.");
      }

      const response: unknown = await generateV2CanvasImageCandidates(canvasSessionId, {
        slot_id: getBackendSlotId(block),
        missing_node_id: getMissingNodeId(block),
        prompt,
        count: 4,
        allow_fallback: false
      });
      if (hasCanvasSession(response)) {
        onCanvasSessionChange?.(response.canvas_session);
      }
      const generatedUris = extractImageCandidateUris(getImageGenerationPayload(response));
      setKeyframeCandidates((candidateMap) => ({
        ...candidateMap,
        [blockId]: generatedUris
      }));
      setSelectedKeyframes((current) => {
        const next = { ...current };
        delete next[blockId];
        return next;
      });
    } catch (error) {
      console.warn("V2 image candidate generation failed.", error);
    } finally {
      setKeyframeLoadingBlockId(null);
    }
  };

  const openCandidateSelector = (blockId: string) => {
    if (!keyframeCandidates[blockId]?.length) {
      generateKeyframeCandidates(blockId);
    }
    setSelectedCandidateUrl(selectedKeyframes[blockId] ?? null);
    setSelectorBlockId(blockId);
  };

  const confirmCandidate = () => {
    if (!selectorBlockId || !selectedCandidateUrl) {
      return;
    }

    setSelectedKeyframes((current) => ({
      ...current,
      [selectorBlockId]: selectedCandidateUrl
    }));
    setSelectorBlockId(null);
    setSelectedCandidateUrl(null);
  };

  const generateVideo = async (block: CanvasBlock, index: number) => {
    const videoPrompt = getVideoPrompt(block, index).trim();
    if (!videoPrompt || generatingVideoBlockId) {
      return;
    }

    const sourceVideoUri = block.v2?.coverageSlot?.direct_video_reference_materials?.[0]?.uri;
    const fallbackImage =
      keyframeCandidates[block.id]?.[0] ?? materialImageForBlock(block) ?? imageForBlock(block, index);
    const generatedKeyframe = keyframeCandidates[block.id]?.[0];
    const payload: VideoGenerationPayload = {
      keyframe_image:
        selectedKeyframes[block.id] ??
        generatedKeyframe ??
        (sourceVideoUri ? undefined : fallbackImage),
      source_video_uri: sourceVideoUri,
      video_prompt: videoPrompt
    };

    setGeneratingVideoBlockId(block.id);
    setActiveEditorBlockId(null);

    try {
      const durationSeconds =
        block.v2?.coverageSlot?.ai_completion_required_duration ??
        block.v2?.coverageSlot?.required_duration ??
        5;
      if (!canvasSessionId) {
        throw new Error("V2 canvas session is required for video generation.");
      }

      const response: unknown = await generateV2CanvasGapVideo(canvasSessionId, {
        approved_image_uri: payload.keyframe_image,
        source_video_uri: payload.source_video_uri,
        duration_seconds: durationSeconds,
        slot_id: getBackendSlotId(block),
        missing_node_id: getMissingNodeId(block),
        video_prompt: payload.video_prompt,
        auto_trim_review: true,
        wait_for_completion: true,
        allow_fallback: false
      });
      if (hasCanvasSession(response)) {
        onCanvasSessionChange?.(response.canvas_session);
      }
      const generatedVideoUri = extractGeneratedVideoUri(getVideoGenerationPayload(response));
      if (!generatedVideoUri) {
        throw new Error("V2 video generation did not return a video URI.");
      }
      const generatedThumbnail =
        payload.keyframe_image ??
        materialImageForBlock(block) ??
        keyframeCandidates[block.id]?.[0] ??
        imageForBlock(block, index);

      setGeneratedVideoUris((current) => ({
        ...current,
        [block.id]: generatedVideoUri
      }));

      setGeneratedVideoThumbs((current) => ({
        ...current,
        [block.id]: generatedThumbnail
      }));

      onUpdateBlock({
        ...block,
        status: "matched",
        materialSummary: "AI 生成视频已完成",
        timeline: block.timeline
          ? {
              ...block.timeline,
              visual_source: "ai_generated_video",
              visual_description: payload.video_prompt
            }
          : block.timeline
      });

      setGeneratingVideoBlockId(null);
    } catch (error) {
      console.warn("V2 image-to-video generation failed.", error);
      setGeneratingVideoBlockId(null);
    }
  };

  const editorBlock = activeEditorBlockId
    ? displayBlocks.find((block) => block.id === activeEditorBlockId)
    : null;
  const editorIndex = editorBlock ? displayBlocks.findIndex((block) => block.id === editorBlock.id) : -1;
  const editorStatus = editorBlock ? getCanvasStatus(editorBlock, editorIndex) : null;
  const editorCanOpen =
    editorBlock &&
    editorStatus &&
    editorStatus !== "generating" &&
    editorStatus !== "matched";
  const editorPosition =
    editorCanOpen
      ? positions[editorBlock.id] ?? basePositions[editorBlock.id]
      : null;

  const selectorBlock = selectorBlockId
    ? displayBlocks.find((block) => block.id === selectorBlockId)
    : null;
  const selectorIndex = selectorBlock
    ? displayBlocks.findIndex((block) => block.id === selectorBlock.id)
    : -1;
  const selectorCandidates = selectorBlockId
    ? keyframeCandidates[selectorBlockId] ?? []
    : [];

  return (
    <section className="figma-canvas-page" aria-label="生成视频">
      <header className="figma-canvas-topbar">
        <button className="figma-canvas-brand" type="button" onClick={onHome ?? onBack}>
          <span>迁镜</span>
          <strong>{projectName}</strong>
          <i aria-hidden="true">✎</i>
        </button>
        <div className="figma-analysis-avatar" aria-label="用户头像" />
      </header>

      <nav className="figma-canvas-tools" aria-label="画布工具">
        <button type="button" title="导出" onClick={onExport}>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M12 4v11" />
            <path d="m7 9 5-5 5 5" />
            <path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
          </svg>
        </button>
        <button type="button" title="帮助" onClick={() => setShowHelp((value) => !value)}>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" />
            <path d="M9.7 9a2.4 2.4 0 0 1 4.55 1.05c0 1.55-1.1 2.06-1.9 2.64-.58.42-.83.82-.83 1.56" />
            <path d="M12 17.4h.01" />
          </svg>
        </button>
        <button type="button" title="返回" onClick={onBack}>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
      </nav>

      <div
        className={`figma-canvas-scroll ${isPanning ? "is-panning" : ""}`}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerCancel={handleCanvasPointerUp}
        onPointerUp={handleCanvasPointerUp}
        onWheel={handleWheel}
        ref={scrollRef}
      >
        <div
          className="figma-canvas-scale-shell"
          style={{
            height: BASE_CANVAS_HEIGHT * (zoom / 100),
            width: BASE_CANVAS_WIDTH * (zoom / 100)
          }}
        >
          <div
            className="figma-canvas-stage"
            style={{
              height: BASE_CANVAS_HEIGHT,
              transform: `scale(${zoom / 100})`,
              width: BASE_CANVAS_WIDTH
            }}
          >
            {!isDragging ? (
              <svg className="figma-canvas-lines" aria-hidden="true">
                {displayBlocks.slice(0, -1).map((block, index) => {
                  const nextBlock = displayBlocks[index + 1];
                  const from = positions[block.id] ?? basePositions[block.id];
                  const to = positions[nextBlock.id] ?? basePositions[nextBlock.id];
                  const solid =
                    getCanvasStatus(block, index) === "matched" &&
                    getCanvasStatus(nextBlock, index + 1) === "matched";

                  if (!from || !to) {
                    return null;
                  }

                  return (
                    <line
                      className={solid ? "solid" : "dashed"}
                      key={`${block.id}-${nextBlock.id}`}
                      x1={from.x + 285}
                      x2={to.x + 3}
                      y1={from.y + 134}
                      y2={to.y + 134}
                    />
                  );
                })}
              </svg>
            ) : null}

            {displayBlocks.map((block, index) => {
              const pos = positions[block.id] ?? basePositions[block.id] ?? { x: 0, y: 0 };
              const selected = selectedBlock?.id === block.id;
              const image =
                generatedVideoThumbs[block.id] ??
                materialImageForBlock(block) ??
                imageForBlock(block, index);
              const cardVideo = generatedVideoUris[block.id] ?? materialVideoForBlock(block);
              const canvasStatus = getCanvasStatus(block, index);
              const gap = needsCompletion(block, index);
              const portTone = portColorByStatus[canvasStatus];
              const aiCompleted = Boolean(generatedVideoUris[block.id] || generatedVideoThumbs[block.id]);
              const playable = Boolean(cardVideo) || canvasStatus === "matched";
              const isGeneratingVideo = canvasStatus === "generating";
              const coverage = block.v2?.coverageSlot;
              const suggestions = suggestionsForBlock(block);
              const missingReason =
                coverage?.gap_reason ||
                coverage?.frontend_display?.material_status ||
                block.gap?.missing ||
                "缺少可匹配素材";

              return (
                <article
                  className={`figma-structure-card status-${canvasStatus} ${selected ? "selected" : ""} ${gap ? "gap" : ""} ${aiCompleted ? "ai-completed" : ""}`}
                  key={block.id}
                  onPointerDown={(event) => handlePointerDown(event, block.id)}
                  onPointerMove={handlePointerMove}
                  onPointerCancel={handlePointerUp}
                  onPointerUp={handlePointerUp}
                  style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
                >
                  <div className="figma-card-label">
                    <span aria-hidden="true" />
                    <strong className="figma-card-dynamic-label">{labelForBlock(block, index)}</strong>
                    <strong>真实素材</strong>
                  </div>
                  <div className="figma-card-frame">
                    <i className={`figma-port top ${portTone}`} aria-hidden="true" />
                    <i className={`figma-port left ${portTone}`} aria-hidden="true" />
                    <i className={`figma-port right ${portTone}`} aria-hidden="true" />
                    <i className="figma-port bottom" aria-hidden="true" />
                    {isGeneratingVideo ? (
                      <div className="figma-generating-state">
                        <span aria-hidden="true" />
                        <strong>Generating</strong>
                      </div>
                    ) : gap ? (
                      <div className="figma-gap-card missing-material">
                        <p className="figma-gap-card-copy">
                          缺少必要素材，
                          <br />
                          试试AI补齐吧！
                        </p>
                        {false ? (
                          <>
                            <strong>结构完整但时长不足</strong>
                            <dl>
                              <div>
                                <dt>当前</dt>
                                <dd>{formatSeconds(coverage?.matched_material_duration)}</dd>
                              </div>
                              <div>
                                <dt>目标</dt>
                                <dd>{formatSeconds(coverage?.required_duration)}</dd>
                              </div>
                              <div>
                                <dt>差值</dt>
                                <dd>{formatSeconds(coverage?.missing_duration)}</dd>
                              </div>
                            </dl>
                            <small>{suggestions.slice(0, 2).join(" / ")}</small>
                          </>
                        ) : (
                          <>
                            <strong>缺失占位</strong>
                            <p>{missingReason}</p>
                            <small>{suggestions.slice(0, 3).join(" / ")}</small>
                          </>
                        )}
                        <p className="legacy-gap-copy">
                          缺少必要素材，
                          <br />
                          试试AI补齐吧！
                        </p>
                      </div>
                    ) : cardVideo ? (
                      <>
                        <video muted playsInline preload="metadata" src={cardVideo} />
                        <button
                          type="button"
                          className="figma-play-overlay"
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") {
                              return;
                            }
                            event.preventDefault();
                            event.stopPropagation();
                            setPlaybackBlockId(block.id);
                          }}
                          title="播放视频"
                        >
                          <span aria-hidden="true" />
                        </button>
                        {aiCompleted ? <em className="figma-ai-complete-tag">AI</em> : null}
                      </>
                    ) : (
                      <>
                        <img alt={labelForBlock(block, index)} draggable={false} src={image} />
                        {playable ? (
                          <button
                            type="button"
                            className="figma-play-overlay"
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter" && event.key !== " ") {
                                return;
                              }
                              event.preventDefault();
                              event.stopPropagation();
                              setPlaybackBlockId(block.id);
                            }}
                            title="播放视频"
                          >
                            <span aria-hidden="true" />
                          </button>
                        ) : null}
                        {aiCompleted ? <em className="figma-ai-complete-tag">AI</em> : null}
                      </>
                    )}
                  </div>
                </article>
              );
            })}

            {editorBlock && editorPosition && editorStatus ? (
              <aside
                className="figma-gap-editor"
                style={{
                  transform: `translate(${Math.max(24, editorPosition.x - 225)}px, ${
                    editorPosition.y + 261
                  }px)`
                }}
              >
                <div className="figma-gap-editor-body">
                  <section className="figma-editor-column keyframe">
                    <p className="figma-editor-label">生成满意的关键帧</p>
                    <div className="figma-prompt-frame">
                      {selectedKeyframes[editorBlock.id] ? (
                        <div className="figma-selected-keyframe">
                          <img alt="已选择关键帧" src={selectedKeyframes[editorBlock.id]} />
                          <div className="figma-selected-keyframe-actions">
                            <span>已选择</span>
                            <button type="button" onClick={() => openCandidateSelector(editorBlock.id)}>
                              重新选择
                            </button>
                          </div>
                        </div>
                      ) : keyframeCandidates[editorBlock.id]?.length ? (
                        <div className="figma-keyframe-result">
                          <button
                            type="button"
                            className="figma-keyframe-thumbs"
                            onClick={() => openCandidateSelector(editorBlock.id)}
                            title="查看候选关键帧"
                          >
                            {keyframeCandidates[editorBlock.id].map((imageUrl, imageIndex) => (
                              <img alt={`关键帧缩略图 ${imageIndex + 1}`} key={imageUrl} src={imageUrl} />
                            ))}
                          </button>
                          <button
                            type="button"
                            className="figma-prompt-action compact"
                            disabled={keyframeLoadingBlockId === editorBlock.id}
                            onClick={() => generateKeyframeCandidates(editorBlock.id)}
                          >
                            {keyframeLoadingBlockId === editorBlock.id ? "生成中" : "重新生成"}
                          </button>
                        </div>
                      ) : (
                        <div className="figma-keyframe-empty">
                          <textarea
                            className="figma-prompt-textarea"
                            onChange={(event) =>
                              setKeyframePrompts((current) => ({
                                ...current,
                                [editorBlock.id]: event.target.value
                              }))
                            }
                            value={getKeyframePrompt(editorBlock, editorIndex)}
                          />
                          <button
                            type="button"
                            className="figma-prompt-action"
                            disabled={keyframeLoadingBlockId === editorBlock.id}
                            onClick={() => generateKeyframeCandidates(editorBlock.id)}
                          >
                            {keyframeLoadingBlockId === editorBlock.id ? "生成中" : "生成图片"}
                          </button>
                        </div>
                      )}
                    </div>
                  </section>

                  <section className="figma-editor-column video">
                    <p className="figma-editor-label">视频生成prompt</p>
                    <div className="figma-prompt-frame video">
                      <textarea
                        className="figma-prompt-textarea"
                        onChange={(event) =>
                          setVideoPrompts((current) => ({
                            ...current,
                            [editorBlock.id]: event.target.value
                          }))
                        }
                        value={getVideoPrompt(editorBlock, editorIndex)}
                      />
                    </div>
                  </section>
                </div>
                <div className="figma-gap-editor-footer">
                  <p>可以在参考提示词的基础上做进一步修改哦~</p>
                  <button
                    type="button"
                    className="figma-generate-video-button"
                    disabled={!getVideoPrompt(editorBlock, editorIndex).trim() || generatingVideoBlockId !== null}
                    onClick={() => generateVideo(editorBlock, editorIndex)}
                  >
                    <span aria-hidden="true">✦</span>
                    AI生成
                  </button>
                </div>
              </aside>
            ) : null}
          </div>
        </div>
      </div>

      <div className="figma-zoom-control" aria-label="缩放比例">
        <button type="button" onClick={resetViewport} title="重置画布">
          复位
        </button>
        <input
          aria-label="缩放百分比"
          inputMode="numeric"
          onBlur={commitZoomDraft}
          onChange={(event) => setZoomDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
          value={zoomDraft}
        />
        <span>%</span>
      </div>

      {showHelp ? (
        <aside className="figma-help-popover">
          <strong>画布状态</strong>
          <span>
            绿色表示已完成，红色表示缺必要输入，黄色表示时长不足。缺失块可单击打开补齐面板。
          </span>
          <span>需要补齐的块与前后结构连接为虚线；空白处可拖动画布，滚轮可缩放。</span>
          <button type="button" onClick={() => setShowHelp(false)}>
            关闭
          </button>
        </aside>
      ) : null}

      {selectorBlock && selectorBlockId ? (
        <div className="figma-ai-modal" role="dialog" aria-modal="true" aria-label="选择关键帧图片">
          <div className="figma-keyframe-modal-panel">
            <aside className="figma-keyframe-modal-sidebar">
              <div className="figma-ai-modal-head">
                <div>
                  <span>关键帧 Prompt</span>
                  <h2>{labelForBlock(selectorBlock, selectorIndex)}</h2>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelectorBlockId(null);
                    setSelectedCandidateUrl(null);
                  }}
                  aria-label="关闭"
                >
                  ×
                </button>
              </div>
              <textarea
                className="figma-keyframe-modal-prompt"
                onChange={(event) =>
                  setKeyframePrompts((current) => ({
                    ...current,
                    [selectorBlockId]: event.target.value
                  }))
                }
                value={getKeyframePrompt(selectorBlock, selectorIndex)}
              />
              <button
                type="button"
                className="figma-prompt-action modal"
                disabled={keyframeLoadingBlockId === selectorBlockId}
                onClick={() => generateKeyframeCandidates(selectorBlockId)}
              >
                {keyframeLoadingBlockId === selectorBlockId ? "生成中" : "重新生成"}
              </button>
            </aside>
            <div className="figma-keyframe-modal-grid">
              {selectorCandidates.map((imageUrl, index) => {
                const selected = selectedCandidateUrl === imageUrl;
                return (
                  <div className="figma-keyframe-choice" key={`${imageUrl}-${index}`}>
                    <button
                      type="button"
                      className={`figma-keyframe-choice-button ${selected ? "is-selected" : ""}`}
                      onClick={() => setSelectedCandidateUrl(imageUrl)}
                    >
                      <img alt={`候选关键帧 ${index + 1}`} src={imageUrl} />
                      {selected ? <span className="figma-candidate-check">✓</span> : null}
                    </button>
                    {selected ? (
                      <div className="figma-candidate-confirm">
                        <p>确认选择该图片作为关键帧吗？</p>
                        <button type="button" onClick={confirmCandidate}>
                          确认
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      {playbackBlockId ? (
        <div className="figma-playback-modal" role="dialog" aria-modal="true" aria-label="视频播放预览">
          <div className="figma-playback-panel">
            {(() => {
              const playbackBlock =
                displayBlocks.find((block) => block.id === playbackBlockId) ?? displayBlocks[0];
              const playbackIndex = displayBlocks.findIndex((block) => block.id === playbackBlockId);
              const videoSrc =
                generatedVideoUris[playbackBlockId] ?? materialVideoForBlock(playbackBlock);
              const poster =
                generatedVideoThumbs[playbackBlockId] ??
                materialImageForBlock(playbackBlock);

              return (
                <>
                  <div className="figma-ai-modal-head">
                    <div>
                      <span>视频预览</span>
                      <h2>{labelForBlock(playbackBlock, playbackIndex)}</h2>
                    </div>
                    <button type="button" onClick={() => setPlaybackBlockId(null)} aria-label="关闭">
                      ×
                    </button>
                  </div>
                  {videoSrc ? (
                    <video className="figma-video-player" controls poster={poster} src={videoSrc} />
                  ) : (
                    <div className="figma-video-placeholder">
                      <span aria-hidden="true" />
                      <strong>播放接口待接入</strong>
                      <p>这里预留后端视频 URL 接入点；拿到生成结果后可替换为真实 video 播放。</p>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      ) : null}

      {selectedBlock ? (
        <div className="figma-canvas-status" aria-live="polite">
          {(() => {
            const index = displayBlocks.findIndex((block) => block.id === selectedBlock.id);
            const status = getCanvasStatus(selectedBlock, index);
            return (
              <>
                <span>{labelForBlock(selectedBlock, index)}</span>
                <strong>{statusTextFor(status, Boolean(generatedVideoUris[selectedBlock.id] || generatedVideoThumbs[selectedBlock.id]))}</strong>
              </>
            );
          })()}
        </div>
      ) : null}
    </section>
  );
};
