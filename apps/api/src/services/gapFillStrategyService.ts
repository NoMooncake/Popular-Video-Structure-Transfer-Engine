import { assertValidSchema, validateSchema } from "../utils/schemaValidator.js";
import type { GapReport } from "./gapDetectService.js";

type FillStrategyType =
  | "text_overlay_fill"
  | "packaging_card_fill"
  | "reuse_existing_material"
  | "aigc_prompt_candidate"
  | "structure_reorder";

type FillStrategy = {
  type: FillStrategyType;
  description: string;
  reason: string;
  timeline_usage: string;
  prompt?: string;
  requires_aigc: boolean;
  priority: "primary" | "fallback";
};

type GapWithStrategies = Omit<GapReport["gaps"][number], "fill_options"> & {
  fill_options: FillStrategy[];
};

export type GapFillStrategyReport = Omit<GapReport, "source" | "gaps"> & {
  source: {
    type: "rule";
    model: "rule_based_gap_fill_strategy_v0.1";
  };
  gaps: GapWithStrategies[];
};

type GapFillStrategyRequest = {
  gap_report?: unknown;
  gapReport?: unknown;
  target_topic?: unknown;
  targetTopic?: unknown;
};

export class GapFillStrategyInputError extends Error {
  statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "GapFillStrategyInputError";
  }
}

const getValidatedGapReport = (value: unknown): GapReport => {
  if (!value) {
    throw new GapFillStrategyInputError("gap_report is required");
  }

  const validationResult = validateSchema("gap_report", value);
  if (!validationResult.valid) {
    throw new GapFillStrategyInputError(
      `gap_report is invalid: ${JSON.stringify(validationResult.errors)}`
    );
  }

  return value as GapReport;
};

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const getGapText = (gap: GapReport["gaps"][number]): string => {
  return [
    gap.slot_type,
    gap.missing,
    gap.impact,
    gap.strategy,
    ...gap.required_materials
  ]
    .join(" ")
    .toLowerCase();
};

const isOpeningGap = (gap: GapReport["gaps"][number]): boolean => {
  const text = getGapText(gap);
  return (
    gap.slot_type.includes("hook") ||
    text.includes("开头") ||
    text.includes("吸引") ||
    text.includes("opening")
  );
};

const isProductGap = (gap: GapReport["gaps"][number]): boolean => {
  const text = getGapText(gap);
  return (
    text.includes("产品") ||
    text.includes("商品") ||
    text.includes("特写") ||
    text.includes("product")
  );
};

const isComparisonGap = (gap: GapReport["gaps"][number]): boolean => {
  const text = getGapText(gap);
  return (
    gap.slot_type.includes("comparison") ||
    text.includes("对比") ||
    text.includes("证明") ||
    text.includes("comparison")
  );
};

const isCtaGap = (gap: GapReport["gaps"][number]): boolean => {
  const text = getGapText(gap);
  return gap.slot_type.includes("cta") || text.includes("cta") || text.includes("结尾");
};

const getOverlayCopy = (
  gap: GapReport["gaps"][number],
  targetTopic: string
): string => {
  if (isOpeningGap(gap)) {
    return `${targetTopic}，先别急着下结论`;
  }

  if (isComparisonGap(gap)) {
    return "把选择理由摆清楚：适合谁，不适合谁";
  }

  if (isCtaGap(gap)) {
    return "评论区告诉我你的情况";
  }

  if (isProductGap(gap)) {
    return "核心卖点先看这一点";
  }

  return "用文字补齐当前画面缺失的信息";
};

const createTextOverlayStrategy = (
  gap: GapReport["gaps"][number],
  targetTopic: string
): FillStrategy => {
  return {
    type: "text_overlay_fill",
    description: `添加字幕/标题覆盖：${getOverlayCopy(gap, targetTopic)}。`,
    reason: "文字覆盖可以在缺少直接画面的情况下快速补齐信息，且实现成本最低。",
    timeline_usage: "在该槽位画面上叠加 1-2 行大字标题或底部字幕。",
    requires_aigc: false,
    priority: "primary"
  };
};

const createPackagingCardStrategy = (
  gap: GapReport["gaps"][number]
): FillStrategy => {
  const cardType = isComparisonGap(gap)
    ? "双栏对比卡"
    : isOpeningGap(gap)
      ? "警示标题卡"
      : isCtaGap(gap)
        ? "底部 CTA 条"
        : "卖点信息卡";

  return {
    type: "packaging_card_fill",
    description: `生成${cardType}，承接缺口：${gap.missing}。`,
    reason: "包装卡片能把抽象卖点、风险和判断标准可视化，适合当前 MVP 的时间线生成。",
    timeline_usage: "作为该槽位的 overlay/card layer，和现有素材或纯色背景组合。",
    requires_aigc: false,
    priority: isComparisonGap(gap) || isOpeningGap(gap) ? "primary" : "fallback"
  };
};

const createReuseMaterialStrategy = (
  gap: GapReport["gaps"][number]
): FillStrategy | undefined => {
  if (gap.available_material_refs.length === 0) {
    return undefined;
  }

  return {
    type: "reuse_existing_material",
    description: `复用现有素材 ${gap.available_material_refs.join(", ")}，通过裁切、放大、定格或重排补齐表达。`,
    reason: "优先复用用户已有素材可以减少生成不确定性，也避免偏离用户真实素材风格。",
    timeline_usage: "把可用素材作为背景层或主画面，配合字幕/卡片完成该槽位。",
    requires_aigc: false,
    priority: "primary"
  };
};

const createAigcPrompt = (
  gap: GapReport["gaps"][number],
  targetTopic: string
): string => {
  if (isOpeningGap(gap)) {
    return `生成竖屏短视频开头画面，主题是“${targetTopic}”的用户痛点或购买风险。画面需要有紧张感和明确注意力中心，不引用、不复刻任何样例视频的具体画面、人物、字幕或构图。`;
  }

  if (isProductGap(gap)) {
    return `生成竖屏产品展示补充画面，主题是“${targetTopic}”。画面突出产品细节、质感和一个核心卖点，不引用、不复刻任何样例视频的具体画面、人物、字幕或构图。`;
  }

  if (isComparisonGap(gap)) {
    return `生成竖屏信息对比背景图，主题是“${targetTopic}”。画面适合放置左右对比卡片和重点标签，不引用、不复刻任何样例视频的具体画面、人物、字幕或构图。`;
  }

  if (isCtaGap(gap)) {
    return `生成竖屏结尾背景画面，主题是“${targetTopic}”。画面留出底部评论引导空间，不引用、不复刻任何样例视频的具体画面、人物、字幕或构图。`;
  }

  return `生成竖屏补充画面，主题是“${targetTopic}”。画面只服务于新内容表达，不引用、不复刻任何样例视频的具体画面、人物、字幕或构图。`;
};

const createAigcStrategy = (
  gap: GapReport["gaps"][number],
  targetTopic: string
): FillStrategy => {
  return {
    type: "aigc_prompt_candidate",
    description: "生成 AIGC 候选 prompt，供后续文生图/图生视频链路使用。",
    reason: "当现有素材和包装仍不足时，AIGC 可以补充缺失画面，但当前阶段只生成 prompt，不直接调用生成服务。",
    timeline_usage: "作为该槽位的候选补充素材生成说明，待用户确认后再进入生成链路。",
    prompt: createAigcPrompt(gap, targetTopic),
    requires_aigc: true,
    priority: "fallback"
  };
};

const createStructureReorderStrategy = (
  gap: GapReport["gaps"][number]
): FillStrategy => {
  return {
    type: "structure_reorder",
    description: `弱化 ${gap.slot_type} 对缺失素材的依赖，把信息前置到字幕或后移到包装卡。`,
    reason: "当素材缺口较难立即补齐时，调整结构可以先保证 MVP 时间线连贯。",
    timeline_usage: "在 timeline generation 中降低该槽位画面权重，改用文字和包装承接。",
    requires_aigc: false,
    priority: "fallback"
  };
};

const createStrategiesForGap = (
  gap: GapReport["gaps"][number],
  targetTopic: string
): FillStrategy[] => {
  const strategies: Array<FillStrategy | undefined> = [
    createTextOverlayStrategy(gap, targetTopic),
    createPackagingCardStrategy(gap),
    createReuseMaterialStrategy(gap),
    createAigcStrategy(gap, targetTopic),
    createStructureReorderStrategy(gap)
  ];

  return strategies.filter((strategy): strategy is FillStrategy => Boolean(strategy));
};

export const generateGapFillStrategies = (
  payload: GapFillStrategyRequest
): GapFillStrategyReport => {
  const gapReport = getValidatedGapReport(payload.gap_report ?? payload.gapReport);
  const targetTopic =
    normalizeOptionalString(payload.target_topic ?? payload.targetTopic) ||
    "新内容";

  const reportWithStrategies: GapFillStrategyReport = {
    ...gapReport,
    id: `gap_fill_strategy_${gapReport.id}`,
    created_at: new Date().toISOString(),
    source: {
      type: "rule",
      model: "rule_based_gap_fill_strategy_v0.1"
    },
    summary: {
      ...gapReport.summary,
      notes:
        gapReport.gaps.length > 0
          ? `${gapReport.summary?.notes || ""} 已为每个缺口生成补全策略，可进入 timeline generation。`.trim()
          : `${gapReport.summary?.notes || ""} 当前没有缺口，timeline generation 可跳过补全策略。`.trim()
    },
    gaps: gapReport.gaps.map((gap) => ({
      ...gap,
      strategy: `${gap.strategy} 已生成可执行补全策略。`,
      fill_options: createStrategiesForGap(gap, targetTopic)
    }))
  };

  assertValidSchema("gap_report", reportWithStrategies);
  return reportWithStrategies;
};
