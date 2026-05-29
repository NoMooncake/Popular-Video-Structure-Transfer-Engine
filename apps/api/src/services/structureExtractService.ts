import { config } from "../config/index.js";
import { assertValidSchema } from "../utils/schemaValidator.js";
import type { SampleAnalysis } from "./sampleAnalyzeService.js";

type TimeRange = {
  start_seconds: number;
  end_seconds: number;
  relative_start_percent: number;
  relative_end_percent: number;
};

type MaterialRequirement = {
  type: string;
  description: string;
  priority: "required" | "recommended" | "optional";
};

type PackagingFeature = {
  type: string;
  description: string;
  style: string;
};

type StructureSlot = {
  slot_id: string;
  slot_type: string;
  time_range: TimeRange;
  content_goal: string;
  rhythm: "slow" | "medium" | "fast" | "mixed";
  required_materials: MaterialRequirement[];
  packaging_features: PackagingFeature[];
  migration_rule: string;
  source_evidence: string[];
  confidence: number;
};

export type StructureBlueprint = {
  id: string;
  version: string;
  created_at: string;
  source: {
    type: "mock" | "sample_analysis";
    ref_id: string;
    model: string;
    prompt_version: string;
  };
  sample_analysis_ref: string;
  vertical: string;
  category: string;
  summary: string;
  detected_structures: ("script" | "rhythm" | "packaging" | "visual")[];
  slots: StructureSlot[];
  global_rhythm: {
    pace: "slow" | "medium" | "fast" | "mixed";
    shot_frequency: string;
    climax_position: TimeRange;
    notes: string;
  };
  packaging_summary: {
    subtitle_density: "none" | "low" | "medium" | "high";
    title_style: string;
    highlight_style: string;
    transition_style: string;
    cover_style: string;
  };
};

export type StructureExtractionInput = {
  sampleAnalysis?: SampleAnalysis;
  vertical?: string;
  category?: string;
  useMock?: boolean;
};

export class StructureExtractionInputError extends Error {
  statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "StructureExtractionInputError";
  }
}

const promptVersion = "sample_structure_extract_v0.1";
const defaultVertical = "seeding_de_seeding";
const defaultCategory = "general";

const round = (value: number): number => {
  return Number(value.toFixed(3));
};

const getDuration = (sampleAnalysis?: SampleAnalysis): number => {
  return sampleAnalysis?.video.duration_seconds || 20;
};

const getRange = (
  durationSeconds: number,
  startPercent: number,
  endPercent: number
): TimeRange => {
  return {
    start_seconds: round((startPercent / 100) * durationSeconds),
    end_seconds: round((endPercent / 100) * durationSeconds),
    relative_start_percent: startPercent,
    relative_end_percent: endPercent
  };
};

const getEvidence = (
  sampleAnalysis: SampleAnalysis | undefined,
  slotIndex: number
): string[] => {
  if (!sampleAnalysis) {
    return ["mock sample structure for seeding/de-seeding vertical"];
  }

  const keyframe = sampleAnalysis.keyframes[slotIndex];
  const shot = sampleAnalysis.shots[slotIndex];
  const evidence = [
    `sample_analysis: ${sampleAnalysis.id}`,
    `transcript_summary: ${sampleAnalysis.transcript.summary}`
  ];

  if (keyframe) {
    evidence.push(`keyframe: ${keyframe.frame_id} at ${keyframe.time_seconds}s`);
  }

  if (shot) {
    evidence.push(`shot: ${shot.shot_id}`);
  }

  return evidence;
};

const getSubtitleDensity = (
  sampleAnalysis?: SampleAnalysis
): "none" | "low" | "medium" | "high" => {
  return sampleAnalysis?.packaging_observations.subtitle_density || "medium";
};

const getSourceRef = (sampleAnalysis?: SampleAnalysis): string => {
  return sampleAnalysis?.id || "mock_sample_analysis";
};

const buildFallbackSlots = (
  durationSeconds: number,
  sampleAnalysis?: SampleAnalysis
): StructureSlot[] => {
  return [
    {
      slot_id: "slot_01",
      slot_type: "risk_or_pain_hook",
      time_range: getRange(durationSeconds, 0, 10),
      content_goal: "用购买风险、踩坑后果或强需求痛点建立注意力。",
      rhythm: "fast",
      required_materials: [
        {
          type: "opening_attraction",
          description: "能在开头制造注意力的强画面，如问题场景、反差画面、产品特写或用户痛点画面。",
          priority: "required"
        },
        {
          type: "hook_copy",
          description: "一句直接点出风险或欲望的开头标题。",
          priority: "required"
        }
      ],
      packaging_features: [
        {
          type: "large_title",
          description: "大字标题压住开头信息，突出风险词或收益词。",
          style: "warning_or_benefit"
        },
        {
          type: "quick_cut",
          description: "前段用快速切换或轻微 zoom 提升停留。",
          style: "fast"
        }
      ],
      migration_rule: "迁移到新主题时，将样例开头的注意力结构替换成新商品或新场景里最强的风险、痛点或收益。",
      source_evidence: getEvidence(sampleAnalysis, 0),
      confidence: 0.82
    },
    {
      slot_id: "slot_02",
      slot_type: "pain_desire_context",
      time_range: getRange(durationSeconds, 10, 25),
      content_goal: "解释用户为什么需要这个产品或为什么不能盲目选择。",
      rhythm: "fast",
      required_materials: [
        {
          type: "problem_context",
          description: "用户困惑、使用前状态、需求分层或错误选择画面。",
          priority: "recommended"
        },
        {
          type: "audience_tags",
          description: "目标人群、适用场景或不适合人群标签。",
          priority: "recommended"
        }
      ],
      packaging_features: [
        {
          type: "tag_list",
          description: "用标签快速列出需求、人群或痛点。",
          style: "dense_tags"
        }
      ],
      migration_rule: "迁移到新内容时，把样例中的背景铺垫压缩为目标用户的需求分层和选择理由。",
      source_evidence: getEvidence(sampleAnalysis, 1),
      confidence: 0.78
    },
    {
      slot_id: "slot_03",
      slot_type: "product_reveal_or_solution",
      time_range: getRange(durationSeconds, 25, 55),
      content_goal: "展示产品、方案或推荐方向，并把核心卖点前置。",
      rhythm: "fast",
      required_materials: [
        {
          type: "product_visual",
          description: "商品外观、包装、功能截图、使用过程或方案示意。",
          priority: "required"
        },
        {
          type: "selling_points",
          description: "可被卡片化呈现的 2-4 个核心卖点。",
          priority: "required"
        }
      ],
      packaging_features: [
        {
          type: "selling_point_card",
          description: "用卖点卡片把产品信息拆成可扫读的信息块。",
          style: "card"
        },
        {
          type: "keyword_highlight",
          description: "高亮核心参数、适合对象或关键结论。",
          style: "highlight"
        }
      ],
      migration_rule: "迁移到新主题时，用新商品/新工具的素材替换样例产品展示，并保持卖点卡片化节奏。",
      source_evidence: getEvidence(sampleAnalysis, 2),
      confidence: 0.84
    },
    {
      slot_id: "slot_04",
      slot_type: "proof_or_comparison",
      time_range: getRange(durationSeconds, 55, 80),
      content_goal: "用对比、证据、标准或体验结果支撑推荐/拔草判断。",
      rhythm: "medium",
      required_materials: [
        {
          type: "comparison_visual",
          description: "前后对比、参数对比、成分/功能表、用户体验证据或测试结果。",
          priority: "required"
        }
      ],
      packaging_features: [
        {
          type: "comparison_card",
          description: "双栏对比、表格卡片或结论卡片。",
          style: "comparison"
        }
      ],
      migration_rule: "迁移到新内容时，把样例的解释段落转换为新商品的可视化证据或横向对比。",
      source_evidence: getEvidence(sampleAnalysis, 3),
      confidence: 0.8
    },
    {
      slot_id: "slot_05",
      slot_type: "decision_warning_cta",
      time_range: getRange(durationSeconds, 80, 100),
      content_goal: "给出购买/不买/如何选择的决策建议，并完成评论或转化 CTA。",
      rhythm: "mixed",
      required_materials: [
        {
          type: "decision_copy",
          description: "明确告诉用户适合买、谨慎买或不要买的条件。",
          priority: "required"
        },
        {
          type: "cta_visual",
          description: "结尾产品摆拍、使用结果或评论引导画面。",
          priority: "recommended"
        }
      ],
      packaging_features: [
        {
          type: "warning_or_cta_bar",
          description: "用底部条或结尾卡片承接决策建议和行动号召。",
          style: "cta"
        }
      ],
      migration_rule: "迁移到新主题时，保留样例的决策收束方式，并替换为新商品的购买建议和互动 CTA。",
      source_evidence: getEvidence(sampleAnalysis, 4),
      confidence: 0.79
    }
  ];
};

export const extractStructureBlueprint = async ({
  sampleAnalysis,
  vertical = defaultVertical,
  category = defaultCategory,
  useMock = false
}: StructureExtractionInput): Promise<StructureBlueprint> => {
  if (!sampleAnalysis && !useMock) {
    throw new StructureExtractionInputError(
      "Request body must include sample_analysis or set use_mock to true"
    );
  }

  const hasLlmKey = config.providers.hasLlmApiKey;
  const sourceRef = getSourceRef(sampleAnalysis);
  const durationSeconds = getDuration(sampleAnalysis);
  const slots = buildFallbackSlots(durationSeconds, sampleAnalysis);

  const blueprint: StructureBlueprint = {
    id: `structure_blueprint_${sourceRef}`,
    version: "0.1.0",
    created_at: new Date().toISOString(),
    source: {
      type: useMock || !sampleAnalysis || !hasLlmKey ? "mock" : "sample_analysis",
      ref_id: sourceRef,
      model: hasLlmKey ? "llm_provider_not_configured_yet" : "fallback_rule_engine",
      prompt_version: promptVersion
    },
    sample_analysis_ref: sourceRef,
    vertical,
    category,
    summary: "该样例符合种草拔草结构：开头用风险/痛点抓注意力，中段展示产品或方案并用卖点卡片承接，后段通过对比证明和决策提醒完成转化或互动。",
    detected_structures: ["script", "rhythm", "packaging", "visual"],
    slots,
    global_rhythm: {
      pace: "mixed",
      shot_frequency: "前 25% 快速建立痛点和对象，中段信息密集展示产品/方案，后 20% 放慢到对比、决策和 CTA。",
      climax_position: getRange(durationSeconds, 55, 80),
      notes: "当前为 fallback 结构拆解；已按种草拔草垂类输出脚本、节奏和包装结构，后续接入 LLM 后可替换为模型生成结果。"
    },
    packaging_summary: {
      subtitle_density: getSubtitleDensity(sampleAnalysis),
      title_style: "大字标题 + 痛点/收益关键词前置",
      highlight_style: "关键词高亮、标签化人群/需求、卖点卡片",
      transition_style: sampleAnalysis?.packaging_observations.transitions.join(", ") || "quick_cut, card_slide, zoom_in",
      cover_style: sampleAnalysis?.packaging_observations.cover_style || "产品/场景特写 + 强标题 + 适合人群标签"
    }
  };

  assertValidSchema("structure_blueprint", blueprint);
  return blueprint;
};
