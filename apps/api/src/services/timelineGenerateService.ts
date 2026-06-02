import { assertValidSchema, validateSchema } from "../utils/schemaValidator.js";

type TimeRange = string | {
  label?: string;
  start_seconds?: number;
  end_seconds?: number;
};

type StructureBlueprint = {
  id: string;
  category?: string;
  slots?: Array<{
    slot_id: string;
    slot_type: string;
    time_range?: TimeRange;
    content_goal?: string;
  }>;
};

type SlotMappingItem = {
  slot_id: string;
  slot_type: string;
  time_range: TimeRange;
  adapted_content_goal: string;
  matched_material_refs: string[];
  matched_segment_refs: string[];
  match_confidence: number;
  material_status: "matched" | "partial" | "missing";
  missing_material: boolean;
  suggested_copy: string;
  packaging_suggestions: string[];
};

type SlotMapping = {
  id: string;
  source: {
    structure_blueprint_ref: string;
    material_analysis_ref: string;
  };
  target: {
    target_topic?: string;
    selling_points?: string[];
  };
  mappings: SlotMappingItem[];
};

type FillOption = {
  type: string;
  description: string;
  reason?: string;
  timeline_usage?: string;
  prompt?: string;
  requires_aigc?: boolean;
  priority?: "primary" | "fallback";
};

type Gap = {
  gap_id: string;
  slot_id: string;
  slot_type: string;
  missing: string;
  impact: string;
  strategy: string;
  available_material_refs?: string[];
  fill_options?: FillOption[];
};

type GapReport = {
  id: string;
  gaps: Gap[];
};

type TimelineRequest = {
  structure_blueprint?: unknown;
  structureBlueprint?: unknown;
  slot_mapping?: unknown;
  slotMapping?: unknown;
  gap_report?: unknown;
  gapReport?: unknown;
  fill_strategies?: unknown;
  fillStrategies?: unknown;
};

type TimelineVisualSource =
  | "user_material"
  | "aigc"
  | "stock"
  | "text_card"
  | "generated_graphic"
  | "reuse"
  | "missing";

type TimelinePackaging = string | {
  type: string;
  text?: string;
  style?: string;
  position?: string;
};

type TimelineItem = {
  item_id: string;
  slot_id: string;
  time_range: TimeRange;
  slot_type: string;
  content_goal: string;
  visual_source: TimelineVisualSource;
  visual_description: string;
  subtitle: string;
  voiceover: string;
  packaging: TimelinePackaging[];
  material_ref?: string | string[];
  gap_ref?: string | string[];
  fill_strategy_ref?: string | string[];
  transition: string;
};

type TimelinePlan = {
  id: string;
  version: string;
  created_at: string;
  source: {
    type: "rule";
    model: "rule_based_timeline_generator_v0.1";
  };
  structure_blueprint_ref: string;
  material_analysis_ref: string;
  gap_report_ref?: string;
  slot_mapping_ref: string;
  target_video: {
    duration_seconds: number;
    aspect_ratio: string;
    platform_style: string;
    title: string;
  };
  script: {
    title: string;
    summary: string;
    full_text: string;
  };
  timeline: TimelineItem[];
  packaging_suggestions: TimelinePackaging[];
  variants: Array<{
    variant_id: string;
    name: string;
    changes: string[];
  }>;
};

export class TimelineGenerateInputError extends Error {
  statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "TimelineGenerateInputError";
  }
}

const DEFAULT_DURATION_SECONDS = 20;
const MIN_DURATION_SECONDS = 15;
const MAX_DURATION_SECONDS = 30;

const unique = (items: string[]): string[] => {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)));
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const getValidatedStructureBlueprint = (
  value: unknown
): StructureBlueprint | undefined => {
  if (!value) {
    return undefined;
  }

  const validationResult = validateSchema("structure_blueprint", value);
  if (!validationResult.valid) {
    throw new TimelineGenerateInputError(
      `structure_blueprint is invalid: ${JSON.stringify(validationResult.errors)}`
    );
  }

  return value as StructureBlueprint;
};

const getValidatedSlotMapping = (value: unknown): SlotMapping => {
  if (!value) {
    throw new TimelineGenerateInputError("slot_mapping is required");
  }

  const validationResult = validateSchema("slot_mapping", value);
  if (!validationResult.valid) {
    throw new TimelineGenerateInputError(
      `slot_mapping is invalid: ${JSON.stringify(validationResult.errors)}`
    );
  }

  return value as SlotMapping;
};

const getValidatedGapReport = (value: unknown): GapReport | undefined => {
  if (!value) {
    return undefined;
  }

  const validationResult = validateSchema("gap_report", value);
  if (!validationResult.valid) {
    throw new TimelineGenerateInputError(
      `gap_report is invalid: ${JSON.stringify(validationResult.errors)}`
    );
  }

  return value as GapReport;
};

const getFillStrategyReport = (payload: TimelineRequest): GapReport | undefined => {
  return getValidatedGapReport(
    payload.fill_strategies ??
      payload.fillStrategies ??
      payload.gap_report ??
      payload.gapReport
  );
};

const parseTimeRange = (timeRange: TimeRange): { start: number; end: number } | undefined => {
  if (typeof timeRange === "string") {
    const match = timeRange.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/u);
    if (!match) {
      return undefined;
    }

    return {
      start: Number(match[1]),
      end: Number(match[2])
    };
  }

  if (
    isRecord(timeRange) &&
    typeof timeRange.start_seconds === "number" &&
    typeof timeRange.end_seconds === "number"
  ) {
    return {
      start: timeRange.start_seconds,
      end: timeRange.end_seconds
    };
  }

  return undefined;
};

const formatSeconds = (value: number): string => {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(1).replace(/\.0$/u, "");
};

const normalizeTimeRange = (
  mapping: SlotMappingItem,
  index: number,
  totalItems: number,
  targetDuration: number
): TimeRange => {
  const parsedRange = parseTimeRange(mapping.time_range);
  if (
    parsedRange &&
    Number.isFinite(parsedRange.start) &&
    Number.isFinite(parsedRange.end) &&
    parsedRange.end > parsedRange.start
  ) {
    return {
      label: `${formatSeconds(parsedRange.start)}-${formatSeconds(parsedRange.end)}s`,
      start_seconds: parsedRange.start,
      end_seconds: parsedRange.end
    };
  }

  const segmentDuration = targetDuration / Math.max(1, totalItems);
  const start = Number((index * segmentDuration).toFixed(2));
  const end = Number(((index + 1) * segmentDuration).toFixed(2));

  return {
    label: `${formatSeconds(start)}-${formatSeconds(end)}s`,
    start_seconds: start,
    end_seconds: end
  };
};

const getTargetDuration = (mappings: SlotMappingItem[]): number => {
  const maxEndSeconds = Math.max(
    0,
    ...mappings
      .map((mapping) => parseTimeRange(mapping.time_range)?.end)
      .filter((value): value is number => typeof value === "number")
  );

  if (maxEndSeconds >= MIN_DURATION_SECONDS) {
    return Math.min(MAX_DURATION_SECONDS, Number(maxEndSeconds.toFixed(1)));
  }

  return DEFAULT_DURATION_SECONDS;
};

const getGapBySlotId = (gapReport?: GapReport): Map<string, Gap> => {
  return new Map((gapReport?.gaps || []).map((gap) => [gap.slot_id, gap]));
};

const getPrimaryFillOption = (gap?: Gap): FillOption | undefined => {
  if (!gap?.fill_options || gap.fill_options.length === 0) {
    return undefined;
  }

  return (
    gap.fill_options.find((option) => option.priority === "primary") ||
    gap.fill_options[0]
  );
};

const getVisualSource = (
  mapping: SlotMappingItem,
  gap?: Gap,
  fillOption?: FillOption
): TimelineVisualSource => {
  if (!gap && mapping.matched_material_refs.length > 0) {
    return "user_material";
  }

  if (
    fillOption?.type === "reuse_existing_material" ||
    fillOption?.type === "material_reuse" ||
    ((gap?.available_material_refs || []).length > 0 &&
      mapping.matched_material_refs.length > 0)
  ) {
    return "reuse";
  }

  if (fillOption?.type === "aigc_prompt_candidate" || fillOption?.type === "aigc") {
    return "aigc";
  }

  if (fillOption?.type === "packaging_card_fill" || fillOption?.type === "packaging") {
    return "generated_graphic";
  }

  if (fillOption?.type === "text_overlay_fill" || fillOption?.type === "copy_or_subtitle") {
    return "text_card";
  }

  return mapping.matched_material_refs.length > 0 ? "reuse" : "missing";
};

const getPackagingType = (slotType: string): string => {
  if (slotType.includes("hook")) {
    return "large_title";
  }

  if (slotType.includes("comparison") || slotType.includes("proof")) {
    return "comparison_card";
  }

  if (slotType.includes("product")) {
    return "selling_point_card";
  }

  if (slotType.includes("cta")) {
    return "bottom_cta_bar";
  }

  return "subtitle_overlay";
};

const createPackaging = (
  mapping: SlotMappingItem,
  fillOption?: FillOption
): TimelinePackaging[] => {
  const packagingFromMapping = mapping.packaging_suggestions.map((suggestion) => ({
    type: getPackagingType(mapping.slot_type),
    text: suggestion,
    style: mapping.material_status === "matched" ? "standard" : "highlight",
    position: mapping.slot_type.includes("cta") ? "bottom" : "center"
  }));

  if (fillOption) {
    packagingFromMapping.push({
      type:
        fillOption.type === "text_overlay_fill"
          ? "subtitle_overlay"
          : fillOption.type === "packaging_card_fill"
            ? "info_card"
            : getPackagingType(mapping.slot_type),
      text: fillOption.timeline_usage || fillOption.description,
      style: fillOption.requires_aigc ? "aigc_candidate" : "gap_fill",
      position: mapping.slot_type.includes("cta") ? "bottom" : "center"
    });
  }

  if (packagingFromMapping.length > 0) {
    return packagingFromMapping;
  }

  return [
    {
      type: getPackagingType(mapping.slot_type),
      text: mapping.suggested_copy,
      style: "standard",
      position: mapping.slot_type.includes("cta") ? "bottom" : "center"
    }
  ];
};

const getVisualDescription = (
  mapping: SlotMappingItem,
  visualSource: TimelineVisualSource,
  gap?: Gap,
  fillOption?: FillOption
): string => {
  if (visualSource === "user_material") {
    return `使用用户素材 ${mapping.matched_material_refs.join(", ")} 承接该槽位。`;
  }

  if (visualSource === "reuse") {
    return `复用用户素材 ${unique([
      ...mapping.matched_material_refs,
      ...(gap?.available_material_refs || [])
    ]).join(", ")}，通过裁切、定格、放大或重排补齐表达。`;
  }

  if (visualSource === "aigc") {
    return fillOption?.prompt || fillOption?.description || gap?.strategy || "使用 AIGC 候选 prompt 补齐缺失画面。";
  }

  if (visualSource === "generated_graphic") {
    return fillOption?.description || gap?.strategy || "使用包装卡片或信息图承接该槽位。";
  }

  if (visualSource === "text_card") {
    return fillOption?.description || "用字幕、标题或纯文字卡补齐当前槽位。";
  }

  return gap?.missing || "该槽位当前仍缺少可用画面，需要前端提示用户补充素材。";
};

const createTimelineItem = (
  mapping: SlotMappingItem,
  index: number,
  totalItems: number,
  targetDuration: number,
  gap?: Gap
): TimelineItem => {
  const fillOption = getPrimaryFillOption(gap);
  const visualSource = getVisualSource(mapping, gap, fillOption);
  const packaging = createPackaging(mapping, fillOption);
  const materialRefs = unique([
    ...mapping.matched_material_refs,
    ...(gap?.available_material_refs || [])
  ]);

  return {
    item_id: `tl_${String(index + 1).padStart(2, "0")}`,
    slot_id: mapping.slot_id,
    time_range: normalizeTimeRange(mapping, index, totalItems, targetDuration),
    slot_type: mapping.slot_type,
    content_goal: mapping.adapted_content_goal,
    visual_source: visualSource,
    visual_description: getVisualDescription(mapping, visualSource, gap, fillOption),
    subtitle: mapping.suggested_copy,
    voiceover: mapping.suggested_copy,
    packaging,
    ...(materialRefs.length === 1
      ? { material_ref: materialRefs[0] }
      : materialRefs.length > 1
        ? { material_ref: materialRefs }
        : {}),
    ...(gap ? { gap_ref: gap.gap_id } : {}),
    ...(fillOption ? { fill_strategy_ref: fillOption.type } : {}),
    transition: index === totalItems - 1 ? "fade_out" : "quick_cut"
  };
};

const getFullScript = (timeline: TimelineItem[]): string => {
  return timeline
    .map((item) => item.voiceover.trim())
    .filter((item) => item.length > 0)
    .join(" ");
};

const getTimelineSummary = (
  timeline: TimelineItem[],
  targetTopic: string
): string => {
  const userMaterialCount = timeline.filter(
    (item) => item.visual_source === "user_material" || item.visual_source === "reuse"
  ).length;
  const fillCount = timeline.length - userMaterialCount;

  return `围绕「${targetTopic}」生成 ${timeline.length} 段短视频时间线，其中 ${userMaterialCount} 段使用或复用用户素材，${fillCount} 段使用补全策略。`;
};

const createPackagingSuggestions = (
  timeline: TimelineItem[]
): TimelinePackaging[] => {
  const suggestions = timeline.flatMap((item) => item.packaging).slice(0, 8);

  if (suggestions.length > 0) {
    return suggestions;
  }

  return [
    {
      type: "subtitle_style",
      text: "全程保留底部字幕，关键信息使用高亮色。",
      style: "readable_short_video",
      position: "bottom"
    }
  ];
};

export const generateTimelinePlan = (
  payload: TimelineRequest
): TimelinePlan => {
  const structureBlueprint = getValidatedStructureBlueprint(
    payload.structure_blueprint ?? payload.structureBlueprint
  );
  const slotMapping = getValidatedSlotMapping(
    payload.slot_mapping ?? payload.slotMapping
  );
  const gapReport = getValidatedGapReport(payload.gap_report ?? payload.gapReport);
  const fillStrategyReport = getFillStrategyReport(payload);
  const gapsBySlotId = getGapBySlotId(fillStrategyReport ?? gapReport);
  const targetDuration = getTargetDuration(slotMapping.mappings);
  const targetTopic =
    slotMapping.target.target_topic ||
    structureBlueprint?.category ||
    "新视频方案";

  const timeline = slotMapping.mappings.map((mapping, index) =>
    createTimelineItem(
      mapping,
      index,
      slotMapping.mappings.length,
      targetDuration,
      gapsBySlotId.get(mapping.slot_id)
    )
  );

  const timelinePlan: TimelinePlan = {
    id: `timeline_plan_${slotMapping.id}`,
    version: "0.1.0",
    created_at: new Date().toISOString(),
    source: {
      type: "rule",
      model: "rule_based_timeline_generator_v0.1"
    },
    structure_blueprint_ref:
      structureBlueprint?.id || slotMapping.source.structure_blueprint_ref,
    material_analysis_ref: slotMapping.source.material_analysis_ref,
    ...(fillStrategyReport?.id || gapReport?.id
      ? { gap_report_ref: fillStrategyReport?.id || gapReport?.id }
      : {}),
    slot_mapping_ref: slotMapping.id,
    target_video: {
      duration_seconds: targetDuration,
      aspect_ratio: "9:16",
      platform_style: "short_video",
      title: targetTopic
    },
    script: {
      title: `${targetTopic} 短视频方案`,
      summary: getTimelineSummary(timeline, targetTopic),
      full_text: getFullScript(timeline)
    },
    timeline,
    packaging_suggestions: createPackagingSuggestions(timeline),
    variants: [
      {
        variant_id: "material_first",
        name: "素材优先版",
        changes: [
          "优先使用用户已有素材和复用策略。",
          "缺口槽位使用字幕和包装卡承接。"
        ]
      },
      {
        variant_id: "aigc_ready",
        name: "AIGC 补全版",
        changes: [
          "保留 AIGC prompt 候选给后续生图/生视频链路。",
          "前端可把 AIGC 槽位标记为待用户确认。"
        ]
      }
    ]
  };

  assertValidSchema("timeline_plan", timelinePlan);
  return timelinePlan;
};
