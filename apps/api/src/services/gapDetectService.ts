import { assertValidSchema, validateSchema } from "../utils/schemaValidator.js";

type SlotMappingItem = {
  slot_id: string;
  slot_type: string;
  required_materials: string[];
  matched_material_refs: string[];
  match_confidence: number;
  material_status: "matched" | "partial" | "missing";
  missing_material: boolean;
  missing_reasons: string[];
};

type SlotMapping = {
  id: string;
  source: {
    structure_blueprint_ref: string;
    material_analysis_ref: string;
  };
  mappings: SlotMappingItem[];
};

type GapType =
  | "opening_attraction"
  | "product_closeup"
  | "usage_process"
  | "comparison_visual"
  | "cta_visual"
  | "general_material";

type Gap = {
  gap_id: string;
  slot_id: string;
  slot_type: string;
  missing: string;
  impact: string;
  severity: "low" | "medium" | "high" | "blocking";
  required_materials: string[];
  available_material_refs: string[];
  strategy: string;
  fill_options: Array<{
    type:
      | "structure_reorder"
      | "copy_or_subtitle"
      | "packaging"
      | "aigc"
      | "material_reuse";
    description: string;
    prompt?: string;
    priority?: "primary" | "fallback";
  }>;
};

export type GapReport = {
  id: string;
  version: string;
  created_at: string;
  source: {
    type: "rule";
    model: "rule_based_gap_detector_v0.1";
  };
  structure_blueprint_ref: string;
  material_analysis_ref: string;
  slot_mapping_ref: string;
  summary: {
    total_gaps: number;
    blocking_gaps: number;
    overall_status: "sufficient" | "partial" | "insufficient";
    notes: string;
  };
  gaps: Gap[];
};

type GapDetectRequest = {
  slot_mapping?: unknown;
  slotMapping?: unknown;
  confidence_threshold?: unknown;
  confidenceThreshold?: unknown;
};

export class GapDetectInputError extends Error {
  statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "GapDetectInputError";
  }
}

const DEFAULT_CONFIDENCE_THRESHOLD = 0.72;

const unique = (items: string[]): string[] => {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)));
};

const getValidatedSlotMapping = (value: unknown): SlotMapping => {
  if (!value) {
    throw new GapDetectInputError("slot_mapping is required");
  }

  const validationResult = validateSchema("slot_mapping", value);
  if (!validationResult.valid) {
    throw new GapDetectInputError(
      `slot_mapping is invalid: ${JSON.stringify(validationResult.errors)}`
    );
  }

  return value as SlotMapping;
};

const getConfidenceThreshold = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CONFIDENCE_THRESHOLD;
  }

  return Math.max(0, Math.min(1, value));
};

const shouldCreateGap = (
  mapping: SlotMappingItem,
  confidenceThreshold: number
): boolean => {
  return (
    mapping.missing_material ||
    mapping.material_status !== "matched" ||
    mapping.match_confidence < confidenceThreshold
  );
};

const getRequirementText = (mapping: SlotMappingItem): string => {
  return [
    mapping.slot_type,
    ...mapping.required_materials,
    ...mapping.missing_reasons
  ]
    .join(" ")
    .toLowerCase();
};

const includesAny = (value: string, keywords: string[]): boolean => {
  return keywords.some((keyword) => value.includes(keyword));
};

const inferGapType = (mapping: SlotMappingItem): GapType => {
  const text = getRequirementText(mapping);

  if (
    mapping.slot_type.includes("hook") ||
    includesAny(text, ["opening", "开头", "吸引", "风险", "hook"])
  ) {
    return "opening_attraction";
  }

  if (
    includesAny(text, [
      "closeup",
      "特写",
      "包装",
      "product_image",
      "product_closeup"
    ])
  ) {
    return "product_closeup";
  }

  if (
    mapping.slot_type.includes("usage") ||
    includesAny(text, ["使用", "过程", "吃粮", "操作", "usage", "process"])
  ) {
    return "usage_process";
  }

  if (
    mapping.slot_type.includes("comparison") ||
    includesAny(text, ["comparison", "对比", "证明", "成分", "横向"])
  ) {
    return "comparison_visual";
  }

  if (
    mapping.slot_type.includes("cta") ||
    includesAny(text, ["cta", "评论", "结尾", "引导"])
  ) {
    return "cta_visual";
  }

  return "general_material";
};

const getMissingText = (gapType: GapType): string => {
  const missingByType: Record<GapType, string> = {
    opening_attraction: "缺少开头吸引镜头",
    product_closeup: "缺少产品特写镜头",
    usage_process: "缺少使用过程镜头",
    comparison_visual: "缺少对比或证明画面",
    cta_visual: "缺少结尾 CTA 镜头",
    general_material: "缺少可直接匹配该结构槽位的素材"
  };

  return missingByType[gapType];
};

const getImpactText = (gapType: GapType, mapping: SlotMappingItem): string => {
  const impactByType: Record<GapType, string> = {
    opening_attraction: "前 3 秒停留风险较高，用户可能还没理解价值就划走。",
    product_closeup: "产品信息不够直观，用户难以快速建立具体认知。",
    usage_process: "缺少真实使用过程会降低可信度和代入感。",
    comparison_visual: "推荐理由缺少可视化证据，种草/拔草判断不够清晰。",
    cta_visual: "结尾行动引导不够聚焦，互动和转化可能变弱。",
    general_material: "该结构槽位无法被当前素材直接承接，影响时间线连贯性。"
  };

  if (mapping.material_status === "partial") {
    return `${impactByType[gapType]} 当前只有部分素材可用，仍需要补全表达。`;
  }

  if (mapping.match_confidence < DEFAULT_CONFIDENCE_THRESHOLD) {
    return `${impactByType[gapType]} 当前匹配置信度偏低，需要人工确认或补充素材。`;
  }

  return impactByType[gapType];
};

const getSeverity = (
  gapType: GapType,
  mapping: SlotMappingItem
): Gap["severity"] => {
  if (mapping.material_status === "missing") {
    return gapType === "opening_attraction" ? "blocking" : "high";
  }

  if (gapType === "opening_attraction" || gapType === "comparison_visual") {
    return "medium";
  }

  return mapping.match_confidence < 0.5 ? "medium" : "low";
};

const getStrategy = (gapType: GapType): string => {
  const strategyByType: Record<GapType, string> = {
    opening_attraction: "优先用强标题、警示色包装和现有素材局部放大补足开头吸引力。",
    product_closeup: "优先从现有素材裁切或局部放大产品区域，必要时补充产品图或 AIGC 背景图。",
    usage_process: "优先复用已有视频片段，或用字幕/卡片解释使用步骤。",
    comparison_visual: "优先生成对比卡片，把卖点、成分、参数或前后差异可视化。",
    cta_visual: "复用结尾可用画面，叠加底部 CTA 条和评论引导文案。",
    general_material: "先用文案、字幕和包装补齐信息，再评估是否需要补充素材。"
  };

  return strategyByType[gapType];
};

const getFillOptions = (gapType: GapType): Gap["fill_options"] => {
  const commonCopyOption = {
    type: "copy_or_subtitle" as const,
    description: "用字幕或标题条补齐当前画面无法直接表达的信息。",
    priority: "primary" as const
  };

  const optionsByType: Record<GapType, Gap["fill_options"]> = {
    opening_attraction: [
      {
        type: "copy_or_subtitle",
        description: "生成强 Hook 标题，直接点出风险或反差。",
        priority: "primary"
      },
      {
        type: "packaging",
        description: "使用警示色标题条、关键词高亮、快速 zoom。",
        priority: "primary"
      },
      {
        type: "aigc",
        description: "根据用户描述生成开头痛点画面或背景图。",
        prompt: "生成一个竖屏短视频开头画面，突出用户正在面临的购买风险或使用痛点。",
        priority: "fallback"
      }
    ],
    product_closeup: [
      {
        type: "material_reuse",
        description: "裁切、放大或定格现有素材中的产品区域。",
        priority: "primary"
      },
      {
        type: "aigc",
        description: "基于产品描述生成产品展示背景图。",
        prompt: "生成竖屏产品特写画面，突出产品包装、质感和核心卖点。",
        priority: "fallback"
      }
    ],
    usage_process: [
      {
        type: "material_reuse",
        description: "复用已有视频片段，按步骤重新排序。",
        priority: "primary"
      },
      commonCopyOption
    ],
    comparison_visual: [
      {
        type: "packaging",
        description: "生成双栏或表格对比卡片。",
        priority: "primary"
      },
      commonCopyOption
    ],
    cta_visual: [
      {
        type: "packaging",
        description: "添加底部评论引导条、按钮式 CTA 或关注提示。",
        priority: "primary"
      },
      {
        type: "material_reuse",
        description: "复用已有素材的末尾画面作为 CTA 背景。",
        priority: "fallback"
      }
    ],
    general_material: [
      commonCopyOption,
      {
        type: "structure_reorder",
        description: "调整段落顺序，降低该槽位对缺失素材的依赖。",
        priority: "fallback"
      }
    ]
  };

  return optionsByType[gapType];
};

const createGap = (
  mapping: SlotMappingItem,
  index: number
): Gap => {
  const gapType = inferGapType(mapping);

  return {
    gap_id: `gap_${String(index + 1).padStart(2, "0")}`,
    slot_id: mapping.slot_id,
    slot_type: mapping.slot_type,
    missing: getMissingText(gapType),
    impact: getImpactText(gapType, mapping),
    severity: getSeverity(gapType, mapping),
    required_materials: mapping.required_materials,
    available_material_refs: mapping.matched_material_refs,
    strategy: getStrategy(gapType),
    fill_options: getFillOptions(gapType)
  };
};

const getOverallStatus = (gaps: Gap[]): GapReport["summary"]["overall_status"] => {
  if (gaps.length === 0) {
    return "sufficient";
  }

  if (gaps.some((gap) => gap.severity === "blocking")) {
    return "insufficient";
  }

  return "partial";
};

export const detectGapsFromSlotMapping = (
  payload: GapDetectRequest
): GapReport => {
  const slotMapping = getValidatedSlotMapping(
    payload.slot_mapping ?? payload.slotMapping
  );
  const confidenceThreshold = getConfidenceThreshold(
    payload.confidence_threshold ?? payload.confidenceThreshold
  );
  const gapCandidates = slotMapping.mappings.filter((mapping) =>
    shouldCreateGap(mapping, confidenceThreshold)
  );
  const gaps = gapCandidates.map(createGap);
  const blockingGaps = gaps.filter((gap) => gap.severity === "blocking").length;

  const gapReport: GapReport = {
    id: `gap_report_${slotMapping.id}`,
    version: "0.1.0",
    created_at: new Date().toISOString(),
    source: {
      type: "rule",
      model: "rule_based_gap_detector_v0.1"
    },
    structure_blueprint_ref: slotMapping.source.structure_blueprint_ref,
    material_analysis_ref: slotMapping.source.material_analysis_ref,
    slot_mapping_ref: slotMapping.id,
    summary: {
      total_gaps: gaps.length,
      blocking_gaps: blockingGaps,
      overall_status: getOverallStatus(gaps),
      notes:
        gaps.length > 0
          ? `识别到 ${gaps.length} 个素材缺口，可进入补全策略生成。`
          : "当前槽位映射未发现明显素材缺口，可进入 timeline generation。"
    },
    gaps
  };

  assertValidSchema("gap_report", gapReport);
  return gapReport;
};
