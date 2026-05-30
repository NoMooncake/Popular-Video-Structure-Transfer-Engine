import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

type LooseRecord = Record<string, unknown>;

export type StructureBlueprint = {
  id: string;
  version: string;
  created_at: string;
  source: {
    type: "mock" | "sample_analysis" | "llm";
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

export class StructureExtractionLlmError extends Error {
  statusCode = 502;

  constructor(message: string) {
    super(message);
    this.name = "StructureExtractionLlmError";
  }
}

const promptVersion = "sample_structure_extract_v0.1";
const defaultVertical = "seeding_de_seeding";
const defaultCategory = "general";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../..");
const promptPath = path.join(repoRoot, "prompts/sample_structure_extract.md");

type ArkChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

type LlmRequestAttempt = {
  baseUrl: string;
  model: string;
};

const sanitizeProviderError = (message: string): string => {
  return message
    .replace(/Request id:\s*[a-zA-Z0-9-]+/gu, "Request id: [redacted]")
    .replace(/request id:\s*[a-zA-Z0-9-]+/gu, "request id: [redacted]")
    .replace(/account\s*\(\d+\)/giu, "account ([redacted])");
};

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

const loadStructurePrompt = (): string => {
  return fs.readFileSync(promptPath, "utf-8");
};

const compactSampleAnalysis = (sampleAnalysis: SampleAnalysis): unknown => {
  return {
    id: sampleAnalysis.id,
    video: sampleAnalysis.video,
    shot_count: sampleAnalysis.shot_count,
    shots: sampleAnalysis.shots.map((shot) => ({
      shot_id: shot.shot_id,
      time_range: shot.time_range,
      keyframe_refs: shot.keyframe_refs,
      visual_tags: shot.visual_tags,
      description: shot.description
    })),
    keyframes: sampleAnalysis.keyframes.map((keyframe) => ({
      frame_id: keyframe.frame_id,
      time_seconds: keyframe.time_seconds,
      uri: keyframe.media.uri
    })),
    transcript: {
      status: sampleAnalysis.transcript.status,
      language: sampleAnalysis.transcript.language,
      summary: sampleAnalysis.transcript.summary,
      segments: sampleAnalysis.transcript.segments
    },
    packaging_observations: sampleAnalysis.packaging_observations
  };
};

const extractJsonObject = (content: string): unknown => {
  const fencedJson = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/u);
  const rawJson = fencedJson?.[1] || content;
  const startIndex = rawJson.indexOf("{");
  const endIndex = rawJson.lastIndexOf("}");

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new StructureExtractionLlmError("LLM response did not contain a JSON object");
  }

  try {
    return JSON.parse(rawJson.slice(startIndex, endIndex + 1)) as unknown;
  } catch {
    throw new StructureExtractionLlmError("LLM response contained invalid JSON");
  }
};

const normalizeLlmBlueprint = (
  rawBlueprint: unknown,
  sampleAnalysis: SampleAnalysis,
  vertical: string,
  category: string
): StructureBlueprint => {
  if (!rawBlueprint || typeof rawBlueprint !== "object") {
    throw new StructureExtractionLlmError("LLM response JSON was not an object");
  }

  const sourceRef = getSourceRef(sampleAnalysis);
  const blueprint = rawBlueprint as Partial<StructureBlueprint> & LooseRecord;
  const fallbackSlots = buildFallbackSlots(sampleAnalysis.video.duration_seconds, sampleAnalysis);
  const rawSlots = Array.isArray(blueprint.slots) ? blueprint.slots : [];
  const normalizedSlots =
    rawSlots.length > 0
      ? rawSlots.map((slot, index) => normalizeLlmSlot(slot, fallbackSlots[index] || fallbackSlots[0], index))
      : fallbackSlots;

  return {
    id: blueprint.id || `structure_blueprint_${sourceRef}`,
    version: blueprint.version || "0.1.0",
    created_at: blueprint.created_at || new Date().toISOString(),
    source: {
      type: "llm",
      ref_id: sourceRef,
      model: config.providers.llm.model,
      prompt_version: promptVersion
    },
    sample_analysis_ref: sourceRef,
    vertical,
    category,
    summary:
      typeof blueprint.summary === "string"
        ? blueprint.summary
        : "LLM 生成的种草拔草结构蓝图。",
    detected_structures: normalizeDetectedStructures(blueprint.detected_structures),
    slots: normalizedSlots,
    global_rhythm: normalizeGlobalRhythm(
      blueprint.global_rhythm,
      sampleAnalysis.video.duration_seconds
    ),
    packaging_summary: normalizePackagingSummary(blueprint.packaging_summary)
  } as StructureBlueprint;
};

const normalizeDetectedStructures = (
  value: unknown
): ("script" | "rhythm" | "packaging" | "visual")[] => {
  const allowed = new Set(["script", "rhythm", "packaging", "visual"]);
  const values = Array.isArray(value) ? value : [];
  const normalized = values.filter((item): item is "script" | "rhythm" | "packaging" | "visual" => {
    return typeof item === "string" && allowed.has(item);
  });

  return normalized.length > 0 ? normalized : ["script", "rhythm", "packaging", "visual"];
};

const normalizeRhythm = (value: unknown): "slow" | "medium" | "fast" | "mixed" => {
  if (value === "slow" || value === "medium" || value === "fast" || value === "mixed") {
    return value;
  }

  const text = typeof value === "string" ? value : "";
  if (/快|fast|高节奏/u.test(text)) {
    return "fast";
  }

  if (/慢|slow/u.test(text)) {
    return "slow";
  }

  if (/混合|mixed|变化/u.test(text)) {
    return "mixed";
  }

  return "medium";
};

const toStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item && typeof item === "object") {
          return JSON.stringify(item);
        }

        return undefined;
      })
      .filter((item): item is string => Boolean(item));
  }

  if (typeof value === "string" && value.length > 0) {
    return [value];
  }

  return [];
};

const normalizeMaterialRequirements = (
  value: unknown,
  fallback: MaterialRequirement[]
): MaterialRequirement[] => {
  if (!Array.isArray(value)) {
    const strings = toStringArray(value);
    return strings.length > 0
      ? strings.map((description, index) => ({
          type: `material_${index + 1}`,
          description,
          priority: index === 0 ? "required" : "recommended"
        }))
      : fallback;
  }

  const normalized = value.map((item, index) => {
    if (typeof item === "string") {
      return {
        type: `material_${index + 1}`,
        description: item,
        priority: index === 0 ? "required" : "recommended"
      } satisfies MaterialRequirement;
    }

    const record = item && typeof item === "object" ? (item as LooseRecord) : {};
    return {
      type: typeof record.type === "string" ? record.type : `material_${index + 1}`,
      description:
        typeof record.description === "string"
          ? record.description
          : JSON.stringify(item),
      priority:
        record.priority === "required" ||
        record.priority === "recommended" ||
        record.priority === "optional"
          ? record.priority
          : index === 0
            ? "required"
            : "recommended"
    } satisfies MaterialRequirement;
  });

  return normalized.length > 0 ? normalized : fallback;
};

const normalizePackagingFeatures = (
  value: unknown,
  fallback: PackagingFeature[]
): PackagingFeature[] => {
  if (!Array.isArray(value)) {
    const strings = toStringArray(value);
    return strings.length > 0
      ? strings.map((description, index) => ({
          type: `packaging_${index + 1}`,
          description,
          style: "llm_generated"
        }))
      : fallback;
  }

  const normalized = value.map((item, index) => {
    if (typeof item === "string") {
      return {
        type: `packaging_${index + 1}`,
        description: item,
        style: "llm_generated"
      } satisfies PackagingFeature;
    }

    const record = item && typeof item === "object" ? (item as LooseRecord) : {};
    return {
      type: typeof record.type === "string" ? record.type : `packaging_${index + 1}`,
      description:
        typeof record.description === "string"
          ? record.description
          : JSON.stringify(item),
      style: typeof record.style === "string" ? record.style : "llm_generated"
    } satisfies PackagingFeature;
  });

  return normalized.length > 0 ? normalized : fallback;
};

const normalizeLlmSlot = (
  value: unknown,
  fallback: StructureSlot,
  index: number
): StructureSlot => {
  const slot = value && typeof value === "object" ? (value as LooseRecord) : {};

  return {
    slot_id:
      typeof slot.slot_id === "string"
        ? slot.slot_id
        : `slot_${String(index + 1).padStart(2, "0")}`,
    slot_type:
      typeof slot.slot_type === "string" ? slot.slot_type : fallback.slot_type,
    time_range:
      slot.time_range && typeof slot.time_range === "object"
        ? (slot.time_range as TimeRange)
        : fallback.time_range,
    content_goal:
      typeof slot.content_goal === "string"
        ? slot.content_goal
        : fallback.content_goal,
    rhythm: normalizeRhythm(slot.rhythm),
    required_materials: normalizeMaterialRequirements(
      slot.required_materials,
      fallback.required_materials
    ),
    packaging_features: normalizePackagingFeatures(
      slot.packaging_features,
      fallback.packaging_features
    ),
    migration_rule:
      typeof slot.migration_rule === "string"
        ? slot.migration_rule
        : fallback.migration_rule,
    source_evidence: toStringArray(slot.source_evidence),
    confidence:
      typeof slot.confidence === "number" &&
      slot.confidence >= 0 &&
      slot.confidence <= 1
        ? slot.confidence
        : 0.75
  };
};

const normalizeGlobalRhythm = (
  value: unknown,
  durationSeconds: number
): StructureBlueprint["global_rhythm"] => {
  const rhythm = value && typeof value === "object" ? (value as LooseRecord) : {};

  return {
    pace: normalizeRhythm(rhythm.pace),
    shot_frequency:
      typeof rhythm.shot_frequency === "string"
        ? rhythm.shot_frequency
        : "LLM 根据样例关键帧与字幕摘要生成的节奏判断。",
    climax_position:
      rhythm.climax_position && typeof rhythm.climax_position === "object"
        ? (rhythm.climax_position as TimeRange)
        : getRange(durationSeconds, 55, 80),
    notes:
      typeof rhythm.notes === "string"
        ? rhythm.notes
        : "已过滤模型输出中的非 schema 字段。"
  };
};

const normalizePackagingSummary = (
  value: unknown
): StructureBlueprint["packaging_summary"] => {
  const packaging = value && typeof value === "object" ? (value as LooseRecord) : {};

  return {
    subtitle_density:
      packaging.subtitle_density === "none" ||
      packaging.subtitle_density === "low" ||
      packaging.subtitle_density === "medium" ||
      packaging.subtitle_density === "high"
        ? packaging.subtitle_density
        : "medium",
    title_style:
      typeof packaging.title_style === "string"
        ? packaging.title_style
        : "大字标题 + 关键词高亮",
    highlight_style:
      typeof packaging.highlight_style === "string"
        ? packaging.highlight_style
        : "标签化重点信息",
    transition_style:
      typeof packaging.transition_style === "string"
        ? packaging.transition_style
        : toStringArray(packaging.transitions).join(", ") || "quick_cut",
    cover_style:
      typeof packaging.cover_style === "string"
        ? packaging.cover_style
        : "产品/场景特写 + 强标题"
  };
};

const callDoubaoStructureExtraction = async (
  sampleAnalysis: SampleAnalysis,
  vertical: string,
  category: string
): Promise<StructureBlueprint> => {
  const endpointId = config.providers.llm.endpointId;
  const apiKey = config.providers.llm.apiKey;

  if (!endpointId || !apiKey) {
    throw new StructureExtractionLlmError("LLM endpoint id or API key is missing");
  }

  const configuredBaseUrl = config.providers.llm.apiBaseUrl.replace(/\/$/u, "");
  const candidateBaseUrls = Array.from(
    new Set([
      configuredBaseUrl,
      "https://ark.cn-beijing.volces.com/api/coding/v3"
    ])
  );
  const candidateModels = Array.from(new Set([endpointId, config.providers.llm.model]));
  const attempts = candidateBaseUrls.flatMap((baseUrl) => {
    return candidateModels.map((model) => ({
      baseUrl,
      model
    }));
  });

  const errors: string[] = [];

  for (const attempt of attempts) {
    const response = await requestDoubaoChatCompletion(
      attempt,
      apiKey,
      sampleAnalysis,
      vertical,
      category
    );

    if (response.blueprint) {
      return response.blueprint;
    }

    errors.push(response.error);
  }

  throw new StructureExtractionLlmError(
    `Doubao structure extraction failed after ${attempts.length} attempt(s): ${errors.join(" | ")}`
  );
};

const requestDoubaoChatCompletion = async (
  attempt: LlmRequestAttempt,
  apiKey: string,
  sampleAnalysis: SampleAnalysis,
  vertical: string,
  category: string
): Promise<{ blueprint: StructureBlueprint; error?: never } | { blueprint?: never; error: string }> => {
  const url = `${attempt.baseUrl}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: attempt.model,
      messages: [
        {
          role: "system",
          content: loadStructurePrompt()
        },
        {
          role: "user",
          content: JSON.stringify({
            vertical,
            category,
            sample_analysis: compactSampleAnalysis(sampleAnalysis)
          })
        }
      ],
      temperature: 0.2,
      max_tokens: 4096
    }),
    signal: AbortSignal.timeout(120_000)
  });

  const body = (await response.json().catch(() => ({}))) as ArkChatCompletionResponse;

  if (!response.ok) {
    return {
      error: sanitizeProviderError(
        `${attempt.baseUrl} returned ${response.status}: ${body.error?.message || response.statusText}`
      )
    };
  }

  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    return {
      error: `${attempt.baseUrl} returned no message content`
    };
  }

  try {
    return {
      blueprint: normalizeLlmBlueprint(
        extractJsonObject(content),
        sampleAnalysis,
        vertical,
        category
      )
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "LLM response parse failed"
    };
  }
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

  if (!useMock && sampleAnalysis && config.providers.llm.enabled) {
    const llmBlueprint = await callDoubaoStructureExtraction(
      sampleAnalysis,
      vertical,
      category
    );

    assertValidSchema("structure_blueprint", llmBlueprint);
    return llmBlueprint;
  }

  const slots = buildFallbackSlots(durationSeconds, sampleAnalysis);

  const blueprint: StructureBlueprint = {
    id: `structure_blueprint_${sourceRef}`,
    version: "0.1.0",
    created_at: new Date().toISOString(),
    source: {
      type: useMock || !sampleAnalysis || !hasLlmKey ? "mock" : "sample_analysis",
      ref_id: sourceRef,
      model: hasLlmKey ? "fallback_rule_engine_missing_endpoint" : "fallback_rule_engine",
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
