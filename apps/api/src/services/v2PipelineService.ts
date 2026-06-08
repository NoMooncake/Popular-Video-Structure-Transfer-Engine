import { config } from "../config/index.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findUploadedVideoById } from "./uploadService.js";
import { runFFmpeg, runFFprobe } from "../utils/ffmpeg.js";
import {
  requestImageCandidates,
  requestImageToVideo,
  requestMultimodalJson,
  requestVideoGenerationTask
} from "../v2/providers/apiJsonClient.js";
import { collectV2ReferenceFramesFromVideos } from "../v2/referenceFrames.js";
import type {
  JsonObject,
  V2FinalAssemblyRequest,
  V2GeneratedVideoTrimReviewRequest,
  V2ImageCandidate,
  V2ImageCandidateRequest,
  V2ImageToVideoRequest,
  V2MaterialCoverage,
  V2PipelineRequest,
  V2PipelineResult,
  V2TextAsset,
  V2UserRequest,
  V2VideoRef
} from "../v2/types.js";

const defaultImageCandidateCount = 4;
const maxImageCandidateCount = 6;

export const normalizeV2TargetDurationSeconds = (value: unknown): number => {
  return Math.max(5, Math.min(60, Number(value || 30)));
};

export class V2PipelineInputError extends Error {
  statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "V2PipelineInputError";
  }
}

const v2SystemPrompt = [
  "你是一个 API-first V2 短视频结构迁移规划引擎。",
  "必须只返回一个合法 JSON object，不要包含 markdown。",
  "所有面向用户阅读的内容必须使用简体中文，包括摘要、分析说明、槽位描述、素材判断、剪辑方案、图片生成 prompt、图生视频 prompt、CTA 文案和备注。",
  "字段名可以保持 snake_case 英文，但字段值必须中文；只有品牌名、模型名、URL、文件名等专有名词可以保留原文。",
  "当前垂类是商业广告短视频，目标时长通常约 15-30 秒。",
  "商业广告结构通常包括：强 Hook、痛点/需求场景、产品亮相、卖点证明、使用过程、效果对比、CTA。",
  "不要照抄样例视频内容，只提取可复用的结构、节奏、视觉逻辑、商业说服逻辑和包装逻辑。",
  "当用户素材不足时，生成服务于新内容的中文生成 prompt，不要复制样例视频中的具体人物、场景或品牌内容。",
  "如果用户素材足够，输出中文剪辑/拼接方案；如果素材不足，先输出中文图片生成 prompt，再输出中文图生视频 prompt。Prompt 不要只写一句话，必须包含结构化细节。",
  "缺失素材的图片生成 prompt 默认应说明：为同一个槽位生成 4 张候选图，供用户选择。4 张图应保持同一广告意图和产品设定，但在构图、光线、景别或背景细节上有差异。",
  "图片生成 prompt 不允许把 4 张候选图设计成 4 个不同主题、不同物体或不同场景；只能围绕一个具体缺失槽位和一个具体视觉主题做四种变体。",
  "图片生成 prompt 如果需要举例，最多只能给一个主示例；不要写“例如 1/2/3/4”这类会导致模型分别生成不同主题的枚举。",
  "人物生成规则：如果用户素材中已经有人物出现，后续生成人物相关镜头时应尽量还原用户素材中的主角形象、年龄感、穿着风格、发型、气质和场景关系。",
  "人物生成规则：如果用户素材中没有人物，且广告结构没有强制要求人物出镜，应优先展示产品、道具、场景、包装和手部动作，不要无故生成新人物。",
  "产品生成规则：如果用户素材中已经出现明确产品或包装，后续生成必须优先保持该产品/包装，不要写禁止出现该产品的负面约束；只能禁止无关品牌、无关产品或错误包装。",
  "人物生成规则：如果结构确实需要人物出镜，但用户素材中没有人物，应详细描述符合产品设定和目标人群的人物样貌、年龄、穿着、状态和动作，且不要生成与产品定位冲突的人设。",
  "图片生成 prompt 建议包含：基础设定、主体/产品、场景环境、构图镜头、光线色彩、质感风格、画面内容、文字/包装元素、负面约束。",
  "图生视频 prompt 建议包含：输入图片对应槽位、镜头景别、构图、运镜、主体动作、环境动态、转场、声音/音效、时长、节奏、画质风格、避免事项。",
  "产品流程是：阅读 2-3 个样例视频，分析用户需求和素材，综合出可填写结构，再规划素材拼接或 AIGC 补全方案。"
].join(" ");

const detailedGenerationPromptRequirements = {
  language: "简体中文",
  image_prompt_required_sections: [
    "基础设定",
    "主体/产品",
    "场景环境",
    "构图与镜头",
    "光线与色彩",
    "质感与风格",
    "画面内容",
    "文字/包装元素",
    "负面约束"
  ],
  image_to_video_prompt_required_sections: [
    "输入图片与对应槽位",
    "景别与构图",
    "运镜方式",
    "主体动作",
    "环境动态",
    "转场方式",
    "声音/音效",
    "时长与节奏",
    "画质风格",
    "避免事项"
  ],
  prompt_quality_rules: [
    "每个 prompt 必须具体到镜头、动作、画面元素和商业广告目的。",
    "每个 prompt 必须基于用户输入的素材、需求和对应槽位，不要泛泛描述。",
    "图片生成 prompt 默认要求生成 4 张候选图供用户选择，并说明四张图之间应在构图、光线、景别或背景细节上形成差异。",
    "4 张候选图必须是同一主题下的四种变体，不允许分别生成 4 个不同物体、不同场景或不同广告方向。",
    "不要用“例如：1...2...3...”列出多个候选主体；如果需要示例，只给一个最符合用户素材和产品的主体示例。",
    "如果用户素材里有人物，人物相关生成必须尽量还原该人物主角形象。",
    "如果用户素材里已有产品、包装或品牌视觉，生成必须优先保留该产品/包装/品牌视觉；不要写“不要出现完整产品”等会和参考素材冲突的限制。",
    "如果用户素材里没有人物，非必要槽位不要生成新人物，应以产品展示、场景、道具、手部动作或包装画面为主。",
    "如果必须新增人物，需详细说明人物年龄、性别气质、穿着、发型、状态、动作，并匹配产品设定和目标人群。",
    "缺什么素材，就为那个缺失槽位生成对应 prompt。",
    "不要复制样例视频中的品牌、人物、场景，只迁移结构和表达方法。",
    "输出要便于直接交给图片生成模型或图生视频模型使用。"
  ]
} as const;

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeOptionalString(item))
    .filter((item): item is string => Boolean(item));
};

const normalizeVideoRefs = (
  explicitRefs: unknown,
  fileIds: unknown,
  role: V2VideoRef["role"]
): V2VideoRef[] => {
  const refs: V2VideoRef[] = [];

  if (Array.isArray(explicitRefs)) {
    for (const item of explicitRefs) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const record = item as Record<string, unknown>;
      const fileId = normalizeOptionalString(record.file_id ?? record.fileId);
      const uri = normalizeOptionalString(record.uri);
      const label = normalizeOptionalString(record.label);

      if (fileId || uri) {
        refs.push({
          file_id: fileId,
          uri: uri || (fileId ? `/api/upload/files/${fileId}` : undefined),
          role,
          label
        });
      }
    }
  }

  for (const fileId of normalizeStringArray(fileIds)) {
    refs.push({
      file_id: fileId,
      uri: `/api/upload/files/${fileId}`,
      role
    });
  }

  return refs;
};

const normalizeTextAssets = (value: unknown): V2TextAsset[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index): V2TextAsset | undefined => {
      if (typeof item === "string") {
        const content = item.trim();
        return content
          ? {
              asset_id: `txt_${String(index + 1).padStart(2, "0")}`,
              type: "copy",
              content
            }
          : undefined;
      }

      if (!item || typeof item !== "object") {
        return undefined;
      }

      const record = item as Record<string, unknown>;
      const content = normalizeOptionalString(record.content);
      if (!content) {
        return undefined;
      }

      const rawType = normalizeOptionalString(record.type);

      return {
        asset_id:
          normalizeOptionalString(record.asset_id ?? record.assetId) ||
          `txt_${String(index + 1).padStart(2, "0")}`,
        type:
          rawType === "brief" ||
          rawType === "copy" ||
          rawType === "note" ||
          rawType === "requirement" ||
          rawType === "other"
            ? rawType
            : "copy",
        content
      };
    })
    .filter((item): item is V2TextAsset => Boolean(item));
};

const normalizeUserRequest = (value: unknown): V2UserRequest => {
  if (!value || typeof value !== "object") {
    throw new V2PipelineInputError("user_request is required");
  }

  const record = value as Record<string, unknown>;
  const goal = normalizeOptionalString(record.goal);

  if (!goal) {
    throw new V2PipelineInputError("user_request.goal is required");
  }

  return {
    goal,
    target_audience: normalizeOptionalString(
      record.target_audience ?? record.targetAudience
    ),
    product_name: normalizeOptionalString(
      record.product_name ?? record.productName ?? record.product
    ),
    style_preferences: normalizeStringArray(
      record.style_preferences ?? record.stylePreferences
    ),
    must_include: normalizeStringArray(record.must_include ?? record.mustInclude),
    avoid: normalizeStringArray(record.avoid)
  };
};

const normalizeRequest = (payload: V2PipelineRequest): Required<V2PipelineRequest> => {
  const referenceVideos = normalizeVideoRefs(
    payload.reference_videos,
    payload.reference_file_ids,
    "reference_sample"
  );
  const userMaterials = normalizeVideoRefs(
    payload.user_materials,
    payload.user_material_file_ids,
    "user_material"
  );
  const textAssets = normalizeTextAssets(payload.text_assets);

  if (referenceVideos.length === 0) {
    throw new V2PipelineInputError(
      "At least one reference video is required; V2 is designed for two or three."
    );
  }

  if (referenceVideos.length > 3) {
    throw new V2PipelineInputError("V2 currently supports at most three reference videos");
  }

  return {
    reference_videos: referenceVideos,
    reference_file_ids: [],
    user_materials: userMaterials,
    user_material_file_ids: [],
    text_assets: textAssets,
    user_request: normalizeUserRequest(payload.user_request),
    options: {
      image_candidate_count: Math.max(
        1,
        Math.min(
          maxImageCandidateCount,
          Number(payload.options?.image_candidate_count || defaultImageCandidateCount)
        )
      ),
      generate_image_candidates:
        payload.options?.generate_image_candidates === true,
      target_duration_seconds: normalizeV2TargetDurationSeconds(
        payload.options?.target_duration_seconds
      ),
      accepted_duration_short_slots: normalizeStringArray(
        payload.options?.accepted_duration_short_slots
      ),
      allow_fallback: payload.options?.allow_fallback !== false
    }
  };
};

const asJsonObject = (value: unknown): JsonObject => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
};

const getPromptPackage = (productionPlan: JsonObject): JsonObject => {
  return asJsonObject(
    productionPlan.generation_prompt_package ||
      productionPlan.prompt_package ||
      productionPlan.aigc_prompt_package
  );
};

const getCanGenerateVideoDirectly = (productionPlan: JsonObject): boolean => {
  return productionPlan.can_generate_video_directly === true;
};

const getNeedsUserImageApproval = (productionPlan: JsonObject): boolean => {
  if (typeof productionPlan.needs_user_image_approval === "boolean") {
    return productionPlan.needs_user_image_approval;
  }

  return !getCanGenerateVideoDirectly(productionPlan);
};

const normalizeImageCandidates = (
  response: JsonObject,
  count: number
): V2ImageCandidate[] => {
  const rawItems = Array.isArray(response.data)
    ? response.data
    : Array.isArray(response.images)
      ? response.images
      : [response];

  return rawItems.slice(0, count).map((item, index) => {
    const record = asJsonObject(item);
    const uri =
      normalizeOptionalString(record.uri) ||
      normalizeOptionalString(record.url) ||
      normalizeOptionalString(record.image_url);

    return {
      candidate_id: `image_candidate_${String(index + 1).padStart(2, "0")}`,
      prompt_ref: normalizeOptionalString(record.prompt_ref) || "prompt_package",
      uri,
      provider_response: record
    };
  });
};

const normalizeReferenceImages = (value: unknown): string[] => {
  return normalizeStringArray(value).filter((image) =>
    /^data:image\/|^https?:\/\//iu.test(image)
  );
};

const normalizeReferenceVideoUris = (value: unknown): V2VideoRef[] => {
  return normalizeStringArray(value).map((uri, index) => ({
    uri,
    role: "user_material",
    label: `reference_video_${String(index + 1).padStart(2, "0")}`
  }));
};

const collectReferenceImagesForGeneration = async (
  videoRefs: V2VideoRef[],
  maxFrames: number
): Promise<string[]> => {
  const frames = await collectV2ReferenceFramesFromVideos(videoRefs, maxFrames);
  return frames.map((frame) => frame.data_url);
};

const sanitizeFallbackReason = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return "Unknown provider failure";
  }

  return error.message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gu, "Bearer [redacted]")
    .replace(/api[_-]?key["':=\s]+[A-Za-z0-9._-]+/giu, "api_key [redacted]")
    .slice(0, 500);
};

const commercialAdSlots = [
  {
    slot_type: "strong_hook",
    role: "前 3 秒抓人，制造停留",
    common_visuals: ["夸张问题", "强视觉", "反差画面"],
    common_packaging: ["大字标题", "快切", "强音效"]
  },
  {
    slot_type: "pain_point_scene",
    role: "制造用户共鸣，说明为什么需要这个商品",
    common_visuals: ["使用前困扰", "生活不便", "旧方案失败"],
    common_packaging: ["痛点字幕", "黑底白字", "问题标签"]
  },
  {
    slot_type: "product_hero",
    role: "让用户知道卖什么",
    common_visuals: ["商品特写", "包装", "品牌露出"],
    common_packaging: ["产品名标题条", "光效", "转场"]
  },
  {
    slot_type: "selling_point_proof",
    role: "解释为什么值得买",
    common_visuals: ["功能细节", "成分", "材质", "参数"],
    common_packaging: ["卖点卡片", "关键词高亮"]
  },
  {
    slot_type: "usage_process",
    role: "展示怎么用，降低理解成本",
    common_visuals: ["手部操作", "场景演示", "步骤拆解"],
    common_packaging: ["步骤字幕", "箭头", "框选"]
  },
  {
    slot_type: "effect_comparison",
    role: "证明有效",
    common_visuals: ["使用前后", "竞品对比", "结果展示"],
    common_packaging: ["对比卡", "左右分屏"]
  },
  {
    slot_type: "cta",
    role: "引导行动",
    common_visuals: ["购买按钮", "优惠信息", "关注引导"],
    common_packaging: ["结尾卡片", "优惠标签", "口播收束"]
  }
] as const;

export const getAdaptiveSlotPlanningRules = (targetDuration: number): JsonObject => {
  if (targetDuration <= 8) {
    return {
      target_slot_count_range: "3-5",
      rule:
        "6-8秒短广告不能机械拆成7个模块。必须合并或舍弃非必要模块，优先保证每个模块表达完整、镜头可读、逻辑顺畅。",
      recommended_structures: [
        "strong_hook + product_hero/selling_point_proof + usage/effect + cta",
        "strong_hook/product_hero + usage_process + effect_comparison/cta",
        "product_hero + selling_point_proof + usage_process + cta"
      ],
      minimum_slot_duration_seconds: 0.8,
      cta_minimum_duration_seconds: 0.5
    };
  }

  if (targetDuration <= 15) {
    return {
      target_slot_count_range: "4-6",
      rule:
        "8-15秒广告可以保留核心商业链路，但仍应按素材和叙事需要合并相邻模块，避免每段过短或重复表达。",
      recommended_structures: [
        "strong_hook + pain/product + selling_point + usage/effect + cta",
        "strong_hook + product_hero + selling_point_proof + usage_process + effect_comparison/cta"
      ],
      minimum_slot_duration_seconds: 1
    };
  }

  return {
    target_slot_count_range: "6-7",
    rule:
      "15秒以上可以展开完整商业广告结构，但仍需根据素材和叙事质量调整时长，不要为了填满模板而重复镜头。",
    recommended_structures: [
      "strong_hook + pain_point_scene + product_hero + selling_point_proof + usage_process + effect_comparison + cta"
    ],
    minimum_slot_duration_seconds: 1.5
  };
};

const makeSlotDuration = (index: number, totalDuration: number): JsonObject => {
  const defaultRanges = [
    [0, 3],
    [3, 7],
    [7, 11],
    [11, 17],
    [17, 22],
    [22, 27],
    [27, 30]
  ];
  const scale = totalDuration / 30;
  const [start, end] = defaultRanges[index] || [index * 4, index * 4 + 4];

  return {
    start_seconds: Number((start * scale).toFixed(1)),
    end_seconds: Number((end * scale).toFixed(1))
  };
};

const readSecondsFromTimeRange = (value: unknown): number | undefined => {
  if (typeof value === "string") {
    const match = value.match(
      /(\d+(?:\.\d+)?)\s*(?:-|~|–|—|到|至)\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?/iu
    );

    if (match) {
      const startSeconds = Number(match[1]);
      const endSeconds = Number(match[2]);
      const durationSeconds = endSeconds - startSeconds;

      return durationSeconds > 0 ? Number(durationSeconds.toFixed(3)) : undefined;
    }
  }

  const timeRange = asJsonObject(value);
  const startSeconds = Number(timeRange.start_seconds ?? timeRange.startSeconds ?? 0);
  const endSeconds = Number(timeRange.end_seconds ?? timeRange.endSeconds);

  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
    return undefined;
  }

  const durationSeconds = endSeconds - startSeconds;
  return durationSeconds > 0 ? Number(durationSeconds.toFixed(3)) : undefined;
};

const getRequiredSlotDuration = (
  slot: JsonObject,
  index: number,
  slotCount: number,
  targetDuration: number
): number => {
  const explicitDuration = Number(
    slot.required_duration ??
      slot.required_duration_seconds ??
      slot.slot_duration_seconds ??
      slot.duration_seconds ??
      slot.duration
  );

  if (Number.isFinite(explicitDuration) && explicitDuration > 0) {
    return Number(explicitDuration.toFixed(3));
  }

  return (
    readSecondsFromTimeRange(slot.time_range) ||
    readSecondsFromTimeRange(slot.timeRange) ||
    readSecondsFromTimeRange(slot.time) ||
    Number((targetDuration / Math.max(1, slotCount)).toFixed(3))
  );
};

const slotAliases = new Map<string, string>([
  ["effect_comparison_or_lifestyle", "effect_comparison"],
  ["lifestyle", "effect_comparison"],
  ["lifestyle_scene", "effect_comparison"],
  ["atmosphere", "effect_comparison"],
  ["social_scene", "effect_comparison"],
  ["product_showcase", "product_hero"],
  ["product_display", "product_hero"],
  ["usage_process_and_effect", "usage_process"],
  ["usage_effect", "usage_process"],
  ["cta_card", "cta"],
  ["call_to_action", "cta"]
]);

const normalizeSlotType = (value: unknown): string | undefined => {
  const rawValue = normalizeOptionalString(value);
  if (!rawValue) {
    return undefined;
  }

  const normalizedValue = rawValue
    .toLowerCase()
    .replace(/[\s-]+/gu, "_")
    .replace(/[^\w_]+/gu, "");

  return slotAliases.get(normalizedValue) || normalizedValue;
};

const normalizeSlotTypes = (value: unknown): string[] => {
  const rawValue = normalizeOptionalString(value);
  if (!rawValue) {
    return [];
  }

  return Array.from(
    new Set(
      rawValue
        .split(/\s*(?:&|,|，|、|\+|\/|和|及|与)\s*/u)
        .map((slotType) => normalizeSlotType(slotType))
        .filter((slotType): slotType is string => Boolean(slotType))
    )
  );
};

const getArchitectureSlots = (
  fillableArchitecture: JsonObject,
  targetDuration: number
): JsonObject[] => {
  const nestedArchitecture = asJsonObject(fillableArchitecture.fillable_architecture);
  const finalPlan = asJsonObject(fillableArchitecture.final_plan);
  const result = asJsonObject(fillableArchitecture.result);
  const resultAdStructure = asJsonObject(result.ad_structure);
  const resultArchitecture = asJsonObject(
    result.fillable_architecture
  );
  const rawSlots =
    (Array.isArray(fillableArchitecture.slots) && fillableArchitecture.slots) ||
    (Array.isArray(fillableArchitecture.structure_slots) &&
      fillableArchitecture.structure_slots) ||
    (Array.isArray(fillableArchitecture.editable_slots) &&
      fillableArchitecture.editable_slots) ||
    (Array.isArray(fillableArchitecture.slot_planning) &&
      fillableArchitecture.slot_planning) ||
    (Array.isArray(fillableArchitecture.planned_structure) &&
      fillableArchitecture.planned_structure) ||
    (Array.isArray(finalPlan.slot_planning) && finalPlan.slot_planning) ||
    (Array.isArray(resultAdStructure.slots) && resultAdStructure.slots) ||
    (Array.isArray(resultAdStructure.structure_slots) &&
      resultAdStructure.structure_slots) ||
    (Array.isArray(nestedArchitecture.slots) && nestedArchitecture.slots) ||
    (Array.isArray(nestedArchitecture.structure_slots) &&
      nestedArchitecture.structure_slots) ||
    (Array.isArray(nestedArchitecture.editable_slots) &&
      nestedArchitecture.editable_slots) ||
    (Array.isArray(nestedArchitecture.slot_planning) &&
      nestedArchitecture.slot_planning) ||
    (Array.isArray(nestedArchitecture.planned_structure) &&
      nestedArchitecture.planned_structure) ||
    (Array.isArray(resultArchitecture.slots) && resultArchitecture.slots) ||
    (Array.isArray(resultArchitecture.structure_slots) &&
      resultArchitecture.structure_slots) ||
    (Array.isArray(resultArchitecture.editable_slots) &&
      resultArchitecture.editable_slots) ||
    (Array.isArray(resultArchitecture.slot_planning) &&
      resultArchitecture.slot_planning) ||
    (Array.isArray(resultArchitecture.planned_structure) &&
      resultArchitecture.planned_structure) ||
    [];

  const slots = rawSlots.map((slot, index) => {
    const record = asJsonObject(slot);
    return {
      ...record,
      slot_id:
        normalizeOptionalString(record.slot_id) ||
        `slot_${String(index + 1).padStart(2, "0")}`,
      slot_type:
        record.slot_type ??
        record.slot ??
        normalizeOptionalString(record.slot_id) ??
        normalizeOptionalString(record.id) ??
        (normalizeSlotType(record.name) ? record.name : undefined) ??
        record.slot_name ??
        record.slot_label,
      slot_name: record.slot_label ?? record.slot_name ?? record.name,
      slot_duration_seconds:
        record.slot_duration_seconds ??
        record.duration_seconds ??
        record.target_duration_seconds,
      visual_goal:
        record.visual_goal ??
        record.visual_direction ??
        record.brief ??
        record.description,
      copy_direction:
        record.copy_direction ??
        record.subtitle_or_vo_direction ??
        record.caption_direction,
      materials:
        record.materials ??
        record.material_ids ??
        record.source_material ??
        record.source_materials
    };
  });
  if (slots.length > 0) {
    return slots;
  }

  return commercialAdSlots.map((slot, index) => ({
    slot_id: `slot_${String(index + 1).padStart(2, "0")}`,
    slot_type: slot.slot_type,
    time_range: makeSlotDuration(index, targetDuration),
    role: slot.role
  }));
};

const extractFileIdFromUploadUri = (uri: string | undefined): string | undefined => {
  if (!uri) {
    return undefined;
  }

  const match = uri.match(/\/api\/upload\/files\/([^/?#]+)/u);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
};

const resolveLocalVideoPath = (videoRef: V2VideoRef): string | undefined => {
  if (videoRef.uri?.startsWith("file://")) {
    const filePath = videoRef.uri.slice("file://".length);
    return fs.existsSync(filePath) ? filePath : undefined;
  }

  if (videoRef.uri?.startsWith("/") && fs.existsSync(videoRef.uri)) {
    return videoRef.uri;
  }

  const fileId = videoRef.file_id || extractFileIdFromUploadUri(videoRef.uri);
  return fileId ? findUploadedVideoById(fileId) : undefined;
};

const readLocalVideoDurationSeconds = async (
  filePath: string | undefined
): Promise<number | undefined> => {
  if (!filePath) {
    return undefined;
  }

  try {
    const probeResult = await runFFprobe(filePath);
    const videoStream = probeResult.streams?.find(
      (stream) => stream.codec_type === "video"
    );
    const durationSeconds =
      Number(videoStream?.duration) || Number(probeResult.format?.duration);

    return Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Number(durationSeconds.toFixed(3))
      : undefined;
  } catch {
    return undefined;
  }
};

const getFrameSampleTimestamps = (durationSeconds: number | undefined): number[] => {
  if (!durationSeconds || durationSeconds <= 0) {
    return [];
  }

  if (durationSeconds <= 1) {
    return [0];
  }

  return [0.15, 0.5, 0.85].map((position) =>
    Number(Math.min(durationSeconds - 0.001, durationSeconds * position).toFixed(3))
  );
};

const getStringField = (record: JsonObject, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = normalizeOptionalString(record[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
};

const getSlotTypeTags = (record: JsonObject): string[] => {
  return Array.from(
    new Set([
      ...normalizeStringArray(record.usable_for_slots),
      ...normalizeStringArray(record.candidate_slot_types),
      ...normalizeStringArray(record.recommended_slot_types),
      ...normalizeStringArray(record.slot_types),
      ...normalizeStringArray(record.fit_slots),
      ...normalizeStringArray(record.applicable_slot_type),
      ...normalizeStringArray(record.applicable_slot_types)
    ]
      .map((slotType) => normalizeSlotType(slotType))
      .filter((slotType): slotType is string => Boolean(slotType)))
  );
};

const collectMaterialModelRecords = (userMaterialAnalysis: JsonObject): JsonObject[] => {
  const nestedMaterialAnalysis = asJsonObject(userMaterialAnalysis.material_analysis);
  const analysisResult = asJsonObject(userMaterialAnalysis.analysis_result);
  const payload = asJsonObject(userMaterialAnalysis.payload);
  const payloadAnalysisResult = asJsonObject(payload.analysis_result);

  return [
    ...(Array.isArray(userMaterialAnalysis.usable_materials)
      ? userMaterialAnalysis.usable_materials
      : []),
    ...(Array.isArray(userMaterialAnalysis.materials)
      ? userMaterialAnalysis.materials
      : []),
    ...(Array.isArray(userMaterialAnalysis.available_materials_analysis)
      ? userMaterialAnalysis.available_materials_analysis
      : []),
    ...(Array.isArray(nestedMaterialAnalysis.usable_materials)
      ? nestedMaterialAnalysis.usable_materials
      : []),
    ...(Array.isArray(nestedMaterialAnalysis.materials)
      ? nestedMaterialAnalysis.materials
      : []),
    ...(Array.isArray(nestedMaterialAnalysis.available_materials_analysis)
      ? nestedMaterialAnalysis.available_materials_analysis
      : []),
    ...(Array.isArray(analysisResult.available_materials_analysis)
      ? analysisResult.available_materials_analysis
      : []),
    ...(Array.isArray(payload.available_materials_analysis)
      ? payload.available_materials_analysis
      : []),
    ...(Array.isArray(payloadAnalysisResult.available_materials_analysis)
      ? payloadAnalysisResult.available_materials_analysis
      : [])
  ].map((item) => asJsonObject(item));
};

const normalizeMaterialReference = (value: unknown): string | undefined => {
  const rawValue = normalizeOptionalString(value);
  if (!rawValue) {
    return undefined;
  }

  const explicitMaterialRef = rawValue.match(/user_material[_\s-]?(\d+)/iu);
  if (explicitMaterialRef?.[1]) {
    return `user_material_${explicitMaterialRef[1].padStart(2, "0")}`;
  }

  const namedMaterialRef = rawValue.match(
    /(?:ice_tea_material|material|source)[_\s-]?0?(\d+)/iu
  );
  if (namedMaterialRef?.[1]) {
    return `user_material_${namedMaterialRef[1].padStart(2, "0")}`;
  }

  const sourceRef = rawValue.match(/(?:素材|source|material)?\s*0?(\d+)/iu);
  if (sourceRef?.[1]) {
    return `user_material_${sourceRef[1].padStart(2, "0")}`;
  }

  return rawValue;
};

const extractMaterialReferences = (value: unknown): string[] => {
  const rawValue = normalizeOptionalString(value);
  if (!rawValue) {
    return [];
  }

  return Array.from(
    new Set(
      Array.from(
        rawValue.matchAll(
          /(?:user_material|素材|source|material|ice_tea_material)[_\s-]?0?(\d+)/giu
        )
      ).map((match) => `user_material_${match[1].padStart(2, "0")}`)
    )
  );
};

const addCoverageHint = (
  hints: Map<string, string[]>,
  materialRef: string,
  slotType: string
): void => {
  hints.set(materialRef, Array.from(new Set([...(hints.get(materialRef) || []), slotType])));
};

const inferSlotTypesFromText = (value: unknown): string[] => {
  const text = normalizeOptionalString(value);
  if (!text) {
    return [];
  }

  const slotTypes: string[] = [];
  if (/strong[_\s-]?hook|hook|开场|开头|抓住注意|冰爽强/iu.test(text)) {
    slotTypes.push("strong_hook");
  }

  if (/pain[_\s-]?point|痛点|口渴|疲惫|炎热/iu.test(text)) {
    slotTypes.push("pain_point_scene");
  }

  if (/product[_\s-]?hero|产品亮相|产品主视觉|商品主视觉|瓶身|产品展示/iu.test(text)) {
    slotTypes.push("product_hero");
  }

  if (/selling[_\s-]?point|proof|卖点|证明|冰爽质感|清爽|水珠|冰块/iu.test(text)) {
    slotTypes.push("selling_point_proof");
  }

  if (/usage[_\s-]?process|使用过程|饮用过程|畅饮|豪饮|使用动作/iu.test(text)) {
    slotTypes.push("usage_process");
  }

  if (/effect[_\s-]?comparison|效果对比|前后对比|满足感|氛围|夏日/iu.test(text)) {
    slotTypes.push("effect_comparison");
  }

  if (/cta|购买引导|行动引导|落版|结尾|立即购买/iu.test(text)) {
    slotTypes.push("cta");
  }

  return Array.from(new Set(slotTypes));
};

const getRecordSlotTypes = (record: JsonObject): string[] => {
  const explicitSlotTypes = Array.from(
    new Set([
      ...normalizeSlotTypes(
        record.slot ??
          record.slot_type ??
          record.slot_name ??
          record.target_slot ??
          record.name
      ),
      ...inferSlotTypesFromText(record.slot_label)
    ])
  );

  if (explicitSlotTypes.length > 0) {
    return explicitSlotTypes;
  }

  return Array.from(
    new Set([
      ...inferSlotTypesFromText(record.brief),
      ...inferSlotTypesFromText(record.description)
    ])
  );
};

const collectCoverageHintsByMaterialRef = (
  userMaterialAnalysis: JsonObject
): Map<string, string[]> => {
  const hints = new Map<string, string[]>();
  const nestedMaterialAnalysis = asJsonObject(userMaterialAnalysis.material_analysis);
  const analysisResult = asJsonObject(userMaterialAnalysis.analysis_result);
  const materialsAnalysis = asJsonObject(userMaterialAnalysis.materials_analysis);
  const directAnalysis = asJsonObject(userMaterialAnalysis.analysis);
  const directPlan = asJsonObject(userMaterialAnalysis.plan);
  const payload = asJsonObject(userMaterialAnalysis.payload);
  const payloadAnalysisResult = asJsonObject(payload.analysis_result);
  const payloadMaterialsAnalysis = asJsonObject(payload.materials_analysis);
  const payloadAnalysis = asJsonObject(payload.analysis);
  const payloadPlan = asJsonObject(payload.plan);
  const nestedUserMaterialAnalysis = asJsonObject(userMaterialAnalysis.user_material_analysis);
  const productionPlan = asJsonObject(userMaterialAnalysis.production_plan);
  const productionPayload = asJsonObject(productionPlan.payload);
  const analysisRoots = [
    userMaterialAnalysis,
    directAnalysis,
    directPlan,
    analysisResult,
    materialsAnalysis,
    nestedMaterialAnalysis,
    nestedUserMaterialAnalysis,
    payload,
    payloadAnalysis,
    payloadPlan,
    payloadAnalysisResult,
    payloadMaterialsAnalysis,
    asJsonObject(payload.user_material_analysis),
    productionPlan,
    productionPayload
  ];
  const coverageBySlot = analysisRoots.flatMap((root) =>
    Array.isArray(root.coverage_by_slot_type) ? root.coverage_by_slot_type : []
  );

  for (const item of coverageBySlot) {
    const record = asJsonObject(item);
    const slotType = normalizeSlotType(record.slot_type);
    const materialRefs = normalizeStringArray(record.material_refs)
      .map((materialRef) => normalizeMaterialReference(materialRef))
      .filter((materialRef): materialRef is string => Boolean(materialRef));

    if (!slotType) {
      continue;
    }

    for (const materialRef of materialRefs) {
      addCoverageHint(hints, materialRef, slotType);
    }
  }

  const materialToSlotMappings = analysisRoots.map((root) =>
    asJsonObject(root.material_to_slot_mapping)
  );
  for (const materialToSlotMapping of materialToSlotMappings) {
    for (const [rawSlotType, rawMaterialRef] of Object.entries(materialToSlotMapping)) {
      const slotType = normalizeSlotType(rawSlotType);
      const materialRef = normalizeMaterialReference(rawMaterialRef);

      if (
        !slotType ||
        !materialRef ||
        /需|新建|aigc|ai|generate|生成|缺|补/u.test(materialRef)
      ) {
        continue;
      }

      addCoverageHint(hints, materialRef, slotType);
    }
  }

  const slotMaterialMappings = analysisRoots.flatMap((root) => [
    asJsonObject(root.slot_material_mapping),
    asJsonObject(root.slot_mapping),
    asJsonObject(root.materials_mapping)
  ]);

  for (const slotMapping of slotMaterialMappings) {
    for (const [rawSlotType, rawMapping] of Object.entries(slotMapping)) {
      const slotType = normalizeSlotType(rawSlotType);
      const mapping = asJsonObject(rawMapping);
      const materialRefs = Array.from(
        new Set([
          ...normalizeStringArray(mapping.materials)
            .map((materialRef) => normalizeMaterialReference(materialRef))
            .filter((materialRef): materialRef is string => Boolean(materialRef)),
          ...extractMaterialReferences(mapping.material_label),
          ...extractMaterialReferences(mapping.material_ref),
          ...extractMaterialReferences(mapping.material),
          ...normalizeStringArray(mapping.source_material).flatMap((materialRef) =>
            extractMaterialReferences(materialRef)
          ),
          ...extractMaterialReferences(mapping.source_material),
          ...extractMaterialReferences(mapping.recommendation),
          ...extractMaterialReferences(mapping.suggestion)
        ])
      )
        .filter((materialRef): materialRef is string => Boolean(materialRef));

      if (!slotType || materialRefs.length === 0) {
        continue;
      }

      for (const materialRef of materialRefs) {
        addCoverageHint(hints, materialRef, slotType);
      }
    }
  }

  const slotSuggestions = analysisRoots.flatMap((root) => {
    const finalPlan = asJsonObject(root.final_plan);

    return [
      ...(Array.isArray(root.material_to_slot_mapping) ? root.material_to_slot_mapping : []),
      ...(Array.isArray(root.specific_suggestions) ? root.specific_suggestions : []),
      ...(Array.isArray(root.detailed_editing_plan) ? root.detailed_editing_plan : []),
      ...(Array.isArray(root.planned_structure) ? root.planned_structure : []),
      ...(Array.isArray(root.slot_analysis) ? root.slot_analysis : []),
      ...(Array.isArray(root.structure) ? root.structure : []),
      ...(Array.isArray(finalPlan.slot_planning) ? finalPlan.slot_planning : []),
      ...(Array.isArray(root["素材到槽位建议"]) ? root["素材到槽位建议"] : []),
      ...(Array.isArray(root["槽位映射与建议"]) ? root["槽位映射与建议"] : [])
    ];
  });

  for (const item of slotSuggestions) {
    const record = asJsonObject(item);
    const slotTypes = getRecordSlotTypes(record);
    const materialRefs = Array.from(
      new Set([
        ...[
          normalizeMaterialReference(
            record.material_label ??
              record.material_ref ??
              record.material ??
              record.source_material
          )
        ].filter((materialRef): materialRef is string => Boolean(materialRef)),
        ...normalizeStringArray(record.source_material)
          .map((materialRef) => normalizeMaterialReference(materialRef))
          .filter((materialRef): materialRef is string => Boolean(materialRef)),
        ...normalizeStringArray(record.source_materials)
          .map((materialRef) => normalizeMaterialReference(materialRef))
          .filter((materialRef): materialRef is string => Boolean(materialRef)),
        ...normalizeStringArray(record.materials)
          .map((materialRef) => normalizeMaterialReference(materialRef))
          .filter((materialRef): materialRef is string => Boolean(materialRef)),
        ...extractMaterialReferences(record.suggestion),
        ...extractMaterialReferences(record.recommendation),
        ...extractMaterialReferences(record.description),
        ...extractMaterialReferences(record.brief),
        ...extractMaterialReferences(record.material_suggestion),
        ...extractMaterialReferences(record.action),
        ...normalizeStringArray(record.material_refs).flatMap((materialRef) =>
          extractMaterialReferences(materialRef)
        )
      ])
    );

    if (slotTypes.length === 0 || materialRefs.length === 0) {
      continue;
    }

    for (const materialRef of materialRefs) {
      for (const slotType of slotTypes) {
        addCoverageHint(hints, materialRef, slotType);
      }
    }
  }

  const availableMaterials = analysisRoots.flatMap((root) =>
    Array.isArray(root.available_materials) ? root.available_materials : []
  );
  for (const item of availableMaterials) {
    const record = asJsonObject(item);
    const materialRefs = Array.from(
      new Set([
        ...extractMaterialReferences(record.label),
        ...extractMaterialReferences(record.material_label),
        ...extractMaterialReferences(record.material_ref),
        ...extractMaterialReferences(record.material),
        ...extractMaterialReferences(record.source)
      ])
    );
    const slotTypes = normalizeStringArray(record.slots_supported)
      .map((slotType) => normalizeSlotType(slotType))
      .filter((slotType): slotType is string => Boolean(slotType));

    if (materialRefs.length === 0 || slotTypes.length === 0) {
      continue;
    }

    for (const materialRef of materialRefs) {
      for (const slotType of slotTypes) {
        addCoverageHint(hints, materialRef, slotType);
      }
    }
  }

  const architectureSlotContainers = analysisRoots.flatMap((root) => [
    asJsonObject(root.fillable_architecture),
    asJsonObject(asJsonObject(root.result).fillable_architecture),
    asJsonObject(root.final_plan)
  ]);
  const architectureSlots = architectureSlotContainers.flatMap((container) =>
    [
      ...(Array.isArray(container.slots) ? container.slots : []),
      ...(Array.isArray(container.slot_planning) ? container.slot_planning : []),
      ...(Array.isArray(container.planned_structure) ? container.planned_structure : [])
    ]
  );

  for (const item of architectureSlots) {
    const record = asJsonObject(item);
    const slotTypes = getRecordSlotTypes(record);
    const materialRefs = Array.from(
      new Set([
        ...normalizeStringArray(record.materials)
          .map((materialRef) => normalizeMaterialReference(materialRef))
          .filter((materialRef): materialRef is string => Boolean(materialRef)),
        ...normalizeStringArray(record.material_ids)
          .map((materialRef) => normalizeMaterialReference(materialRef))
          .filter((materialRef): materialRef is string => Boolean(materialRef)),
        ...extractMaterialReferences(record.material_id),
        ...extractMaterialReferences(record.material_ref),
        ...normalizeStringArray(record.source_material)
          .map((materialRef) => normalizeMaterialReference(materialRef))
          .filter((materialRef): materialRef is string => Boolean(materialRef)),
        ...normalizeStringArray(record.source_materials)
          .map((materialRef) => normalizeMaterialReference(materialRef))
          .filter((materialRef): materialRef is string => Boolean(materialRef)),
        ...extractMaterialReferences(record.suggestion),
        ...extractMaterialReferences(record.recommendation),
        ...extractMaterialReferences(record.description),
        ...extractMaterialReferences(record.brief)
      ])
    );

    if (slotTypes.length === 0 || materialRefs.length === 0) {
      continue;
    }

    for (const materialRef of materialRefs) {
      for (const slotType of slotTypes) {
        addCoverageHint(hints, materialRef, slotType);
      }
    }
  }

  return hints;
};

const findMaterialModelRecord = (
  records: JsonObject[],
  materialRef: V2VideoRef,
  fallbackMaterialId: string
): JsonObject => {
  const fileId = materialRef.file_id || extractFileIdFromUploadUri(materialRef.uri);
  const labelRef = normalizeMaterialReference(materialRef.label);

  return (
    records.find((record) => {
      const sourceRef = normalizeMaterialReference(record.source);
      const recordRefs = [
        record.file_name,
        record.fileName,
        record.label,
        record.name,
        record.material_label,
        record.material_ref,
        record.material,
        record.source,
        record.id,
        record.material_id,
        record.asset_id
      ]
        .map((value) => normalizeMaterialReference(value))
        .filter((value): value is string => Boolean(value));
      const materialIndex = Number(record.material_index ?? record.index);
      const indexedMaterialRef =
        Number.isFinite(materialIndex) && materialIndex > 0
          ? `user_material_${String(materialIndex).padStart(2, "0")}`
          : undefined;

      return (
        getStringField(record, ["material_id", "id", "asset_id"]) ===
          fallbackMaterialId ||
        sourceRef === fallbackMaterialId ||
        recordRefs.includes(fallbackMaterialId) ||
        (labelRef && recordRefs.includes(labelRef)) ||
        indexedMaterialRef === fallbackMaterialId ||
        (fileId && getStringField(record, ["file_id", "fileId"]) === fileId) ||
        (materialRef.uri &&
          getStringField(record, ["uri", "path", "url"]) === materialRef.uri)
      );
    }) || {}
  );
};

const getPromptSlotTypes = (promptRecord: JsonObject): string[] => {
  const explicitSlotType = normalizeSlotType(
    promptRecord.slot_type ??
      promptRecord.slot_id ??
      promptRecord.slot ??
      promptRecord.slot_name ??
      promptRecord.target_slot ??
      promptRecord.missing_slot
  );
  if (explicitSlotType) {
    return [explicitSlotType];
  }

  const searchableText = [
    promptRecord.purpose,
    promptRecord.intent,
    promptRecord.prompt_ref,
    promptRecord.prompt_description,
    promptRecord.prompt
  ]
    .map((value) => normalizeOptionalString(value))
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const inferredSlotTypes: string[] = [];

  if (/strong[_\s-]?hook|强\s*hook|强hook|开头|抓住注意/iu.test(searchableText)) {
    inferredSlotTypes.push("strong_hook");
  }

  if (/selling[_\s-]?point|proof|卖点|证明/iu.test(searchableText)) {
    inferredSlotTypes.push("selling_point_proof");
  }

  if (/product[_\s-]?hero|产品亮相|产品主视觉|商品主视觉/iu.test(searchableText)) {
    inferredSlotTypes.push("product_hero");
  }

  if (/usage[_\s-]?process|使用过程|饮用过程|畅饮|仰头痛饮|开盖.*饮/iu.test(searchableText)) {
    inferredSlotTypes.push("usage_process");
  }

  if (/effect[_\s-]?comparison|效果对比|前后对比/iu.test(searchableText)) {
    inferredSlotTypes.push("effect_comparison");
  }

  if (/cta|购买引导|即刻购买|行动引导|结尾/iu.test(searchableText)) {
    inferredSlotTypes.push("cta");
  }

  return Array.from(new Set(inferredSlotTypes));
};

const getPromptTextFromSections = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const sections = asJsonObject(value);
  const lines = Object.entries(sections)
    .map(([sectionName, sectionValue]) => {
      const sectionText = normalizeOptionalString(sectionValue);
      return sectionText ? `【${sectionName}】${sectionText}` : undefined;
    })
    .filter((line): line is string => Boolean(line));

  return lines.length > 0 ? lines.join("\n") : undefined;
};

const getPromptTextFromRecord = (record: JsonObject): string | undefined => {
  return (
    normalizeOptionalString(record.prompt) ||
    normalizeOptionalString(record.image_prompt) ||
    normalizeOptionalString(record.prompt_description) ||
    getPromptTextFromSections(record.content) ||
    getPromptTextFromSections(record.sections)
  );
};

const collectAigcImagePromptsBySlot = (
  fillableArchitecture: JsonObject
): Map<string, JsonObject> => {
  const promptsBySlot = new Map<string, JsonObject>();
  const addPromptRecord = (promptRecord: JsonObject, fallbackSlot?: unknown): void => {
    const promptText = getPromptTextFromRecord(promptRecord);
    const promptWithSlot =
      fallbackSlot && !getPromptSlotTypes(promptRecord).length
        ? {
            ...promptRecord,
            slot_type: fallbackSlot,
            prompt: promptText
          }
        : {
            ...promptRecord,
            prompt: promptText
          };
    const slotTypes = getPromptSlotTypes(promptWithSlot);

    for (const slotType of slotTypes) {
      if (!promptsBySlot.has(slotType)) {
        promptsBySlot.set(slotType, promptWithSlot);
      }
    }
  };
  const resultArchitecture = asJsonObject(
    asJsonObject(fillableArchitecture.result).fillable_architecture
  );
  const payload = asJsonObject(fillableArchitecture.payload);
  const assemblyGenerationPlan = asJsonObject(
    asJsonObject(fillableArchitecture.assembly).ai_generation_plan
  );
  const payloadAssemblyGenerationPlan = asJsonObject(
    asJsonObject(payload.assembly).ai_generation_plan
  );
  const payloadGenerationPlan = asJsonObject(payload.generation_plan);
  const nestedPromptContainers = [
    asJsonObject(fillableArchitecture),
    payload,
    asJsonObject(fillableArchitecture.missing_material_prompts),
    asJsonObject(payload.missing_material_prompts),
    asJsonObject(fillableArchitecture.aigc_prompts),
    asJsonObject(asJsonObject(fillableArchitecture.fillable_architecture).aigc_prompts),
    asJsonObject(resultArchitecture),
    asJsonObject(resultArchitecture.aigc_prompts),
    asJsonObject(fillableArchitecture.generation_prompt_package),
    asJsonObject(fillableArchitecture.prompt_package),
    asJsonObject(fillableArchitecture.prompts_for_missing),
    asJsonObject(resultArchitecture.generation_prompt_package),
    asJsonObject(resultArchitecture.prompt_package),
    asJsonObject(resultArchitecture.prompts_for_missing),
    assemblyGenerationPlan,
    payloadAssemblyGenerationPlan,
    payloadGenerationPlan
  ];

  for (const container of nestedPromptContainers) {
    const promptItems = [
      ...(Array.isArray(container.picture_generation_prompts)
        ? container.picture_generation_prompts
        : []),
      ...(Array.isArray(container.image_prompt_candidates)
        ? container.image_prompt_candidates
        : []),
      ...(Array.isArray(container.image_prompts) ? container.image_prompts : []),
      ...(Array.isArray(container.image_generation_prompts)
        ? container.image_generation_prompts
        : []),
      ...(Array.isArray(container.aigc_generation_plan)
        ? container.aigc_generation_plan
        : []),
      ...(Array.isArray(container.prompt_generators)
        ? container.prompt_generators
        : [])
    ];

    for (const item of promptItems) {
      addPromptRecord(asJsonObject(item));
    }

    for (const [key, value] of Object.entries(container)) {
      if (!/_?image_?generation_?prompt$/iu.test(key)) {
        continue;
      }

      const promptRecord = asJsonObject(value);
      const fallbackSlot = key.replace(/_?image_?generation_?prompt$/iu, "");
      addPromptRecord(promptRecord, fallbackSlot);
    }

    const generativeSlots = Array.isArray(container.generative_slots)
      ? container.generative_slots
      : [];
    for (const item of generativeSlots) {
      const slotRecord = asJsonObject(item);
      const fallbackSlot =
        slotRecord.slot_type ??
        slotRecord.slot_id ??
        slotRecord.slot ??
        slotRecord.slot_name ??
        slotRecord.target_slot;
      const imagePrompts = [
        ...(Array.isArray(slotRecord.image_prompts) ? slotRecord.image_prompts : []),
        ...(Array.isArray(slotRecord.image_prompt_candidates)
          ? slotRecord.image_prompt_candidates
          : []),
        ...(Array.isArray(slotRecord.picture_generation_prompts)
          ? slotRecord.picture_generation_prompts
          : [])
      ];

      for (const promptItem of imagePrompts) {
        addPromptRecord(asJsonObject(promptItem), fallbackSlot);
      }
    }

    const generationItems = Array.isArray(container.items) ? container.items : [];
    for (const item of generationItems) {
      const generationItem = asJsonObject(item);
      const fallbackSlot =
        generationItem.slot_type ??
        generationItem.slot_id ??
        generationItem.slot ??
        generationItem.slot_name ??
        generationItem.name;
      const promptObject = asJsonObject(generationItem.prompt);
      const imageGenerationPrompt =
        asJsonObject(promptObject.image_generation).sections ||
        asJsonObject(promptObject.image_generation);
      const promptText =
        getPromptTextFromSections(imageGenerationPrompt) ||
        getPromptTextFromRecord(promptObject);

      if (promptText) {
        addPromptRecord(
          {
            prompt_ref: normalizeSlotType(fallbackSlot) || "image_generation",
            prompt: promptText
          },
          fallbackSlot
        );
      }
    }
  }

  const supplementPlans = [
    asJsonObject(fillableArchitecture.aigc_supplement_plan),
    asJsonObject(asJsonObject(fillableArchitecture.fillable_architecture).aigc_supplement_plan),
    asJsonObject(resultArchitecture.aigc_supplement_plan)
  ];

  for (const plan of supplementPlans) {
    const promptRecord = asJsonObject(plan.image_generation_prompt);
    const slotType = normalizeSlotType(
      promptRecord.slot_type ||
        promptRecord.slot_id ||
        promptRecord.slot_name ||
        plan.missing_slot
    );

    if (slotType && Object.keys(promptRecord).length > 0 && !promptsBySlot.has(slotType)) {
      promptsBySlot.set(slotType, promptRecord);
    }
  }

  return promptsBySlot;
};

const collectAigcVideoPromptsBySlot = (
  fillableArchitecture: JsonObject
): Map<string, JsonObject> => {
  const promptsBySlot = new Map<string, JsonObject>();
  const addPromptRecord = (promptRecord: JsonObject, fallbackSlot?: unknown): void => {
    const promptText = getPromptTextFromRecord(promptRecord);
    const promptWithSlot =
      fallbackSlot && !getPromptSlotTypes(promptRecord).length
        ? {
            ...promptRecord,
            slot_type: fallbackSlot,
            prompt: promptText
          }
        : {
            ...promptRecord,
            prompt: promptText
          };
    const slotTypes = getPromptSlotTypes(promptWithSlot);

    for (const slotType of slotTypes) {
      if (!promptsBySlot.has(slotType)) {
        promptsBySlot.set(slotType, promptWithSlot);
      }
    }
  };
  const resultArchitecture = asJsonObject(
    asJsonObject(fillableArchitecture.result).fillable_architecture
  );
  const payload = asJsonObject(fillableArchitecture.payload);
  const promptContainers = [
    asJsonObject(fillableArchitecture),
    payload,
    asJsonObject(fillableArchitecture.aigc_prompts),
    asJsonObject(asJsonObject(fillableArchitecture.fillable_architecture).aigc_prompts),
    asJsonObject(resultArchitecture),
    asJsonObject(resultArchitecture.aigc_prompts),
    asJsonObject(fillableArchitecture.generation_prompt_package),
    asJsonObject(fillableArchitecture.prompt_package),
    asJsonObject(resultArchitecture.generation_prompt_package),
    asJsonObject(resultArchitecture.prompt_package),
    asJsonObject(asJsonObject(fillableArchitecture.assembly).ai_generation_plan),
    asJsonObject(asJsonObject(payload.assembly).ai_generation_plan),
    asJsonObject(payload.generation_plan)
  ];

  for (const container of promptContainers) {
    const promptItems = [
      ...(Array.isArray(container.video_prompt_candidates)
        ? container.video_prompt_candidates
        : []),
      ...(Array.isArray(container.video_prompts) ? container.video_prompts : []),
      ...(Array.isArray(container.video_generation_prompts)
        ? container.video_generation_prompts
        : []),
      ...(Array.isArray(container.image_to_video_prompts)
        ? container.image_to_video_prompts
        : [])
    ];

    for (const item of promptItems) {
      addPromptRecord(asJsonObject(item));
    }

    for (const [key, value] of Object.entries(container)) {
      if (!/(?:_?video_?generation_?prompt|_?image_?to_?video_?prompt)$/iu.test(key)) {
        continue;
      }

      const fallbackSlot = key
        .replace(/_?video_?generation_?prompt$/iu, "")
        .replace(/_?image_?to_?video_?prompt$/iu, "");
      addPromptRecord(asJsonObject(value), fallbackSlot);
    }

    const generativeSlots = Array.isArray(container.generative_slots)
      ? container.generative_slots
      : [];
    for (const item of generativeSlots) {
      const slotRecord = asJsonObject(item);
      const fallbackSlot =
        slotRecord.slot_type ??
        slotRecord.slot_id ??
        slotRecord.slot ??
        slotRecord.slot_name ??
        slotRecord.target_slot;
      const videoPrompts = [
        ...(Array.isArray(slotRecord.video_prompts) ? slotRecord.video_prompts : []),
        ...(Array.isArray(slotRecord.video_prompt_candidates)
          ? slotRecord.video_prompt_candidates
          : []),
        ...(Array.isArray(slotRecord.image_to_video_prompts)
          ? slotRecord.image_to_video_prompts
          : [])
      ];

      for (const promptItem of videoPrompts) {
        addPromptRecord(asJsonObject(promptItem), fallbackSlot);
      }
    }
  }

  return promptsBySlot;
};

const isAcceptedDurationShortSlot = (
  acceptedSlots: Set<string>,
  slotId: string,
  slotType: string
): boolean => {
  return acceptedSlots.has(slotId) || acceptedSlots.has(slotType);
};

const getFrontendCoverageLabel = (frontendCoverageStatus: string): string => {
  if (frontendCoverageStatus === "fully_matched") {
    return "完全匹配";
  }

  if (frontendCoverageStatus === "structure_complete_duration_short") {
    return "结构完整，但时长不足";
  }

  return "素材不够";
};

const formatFrontendSeconds = (seconds: number): string => {
  if (!Number.isFinite(seconds)) {
    return "0s";
  }

  return `${Number(seconds.toFixed(3))}s`;
};

const formatFrontendMaterialSummary = (
  matches: JsonObject[],
  candidateMaterials: JsonObject[]
): string => {
  if (matches.length > 0) {
    return matches
      .map((match) => {
        const label =
          normalizeOptionalString(match.label) ||
          normalizeOptionalString(match.model_label) ||
          normalizeOptionalString(match.material_id) ||
          "已分配素材";
        const duration = Number(match.matched_material_duration || 0);

        return `${label} ${formatFrontendSeconds(duration)}`;
      })
      .join("\n");
  }

  if (candidateMaterials.length > 0) {
    return candidateMaterials
      .map((material) => {
        const label =
          normalizeOptionalString(material.label) ||
          normalizeOptionalString(material.model_label) ||
          normalizeOptionalString(material.material_id) ||
          "候选素材";
        const duration = Number(material.duration_seconds || 0);

        return duration > 0 ? `${label} 候选 ${formatFrontendSeconds(duration)}` : `${label} 候选`;
      })
      .join("\n");
  }

  return "空";
};

const getSlotFallbackPrompt = (
  normalized: Required<V2PipelineRequest>,
  slot: JsonObject,
  slotType: string
): string => {
  const productName = normalized.user_request.product_name || "目标产品";
  const goal = normalized.user_request.goal;
  const audience = normalized.user_request.target_audience || "目标用户";
  const visualDirection =
    normalizeOptionalString(slot.visual_direction) ||
    normalizeOptionalString(slot.visualDirection) ||
    normalizeOptionalString(slot.scene_description) ||
    normalizeOptionalString(slot.sceneDescription) ||
    normalizeOptionalString(slot.description) ||
    normalizeOptionalString(slot.purpose) ||
    "根据该广告槽位补足缺失画面，画面必须服务于当前结构段落。";
  const shotDirection =
    normalizeOptionalString(slot.shot_type) ||
    normalizeOptionalString(slot.shotType) ||
    normalizeOptionalString(slot.camera_movement) ||
    normalizeOptionalString(slot.cameraMovement);
  const textDirection =
    normalizeOptionalString(slot.text_or_voiceover) ||
    normalizeOptionalString(slot.text_direction) ||
    normalizeOptionalString(slot.subtitle_direction) ||
    normalizeOptionalString(slot.copy_direction);
  const packagingSuggestion =
    normalizeOptionalString(slot.packaging_suggestion) ||
    normalizeOptionalString(slot.packaging);

  return [
    `【基础设定】竖屏 9:16 商业广告关键帧，用于 ${slotType} 槽位；产品为${productName}，广告目标是“${goal}”。`,
    "【候选图要求】生成 4 张候选图供用户选择，四张图必须围绕同一个具体主题、同一产品设定和同一槽位意图，只在构图、光线、景别、镜头角度或背景细节上有差异。",
    `【主体/产品】主体必须围绕${productName}或与${productName}直接相关的使用/购买场景，面向“${audience}”。`,
    `【场景环境】${visualDirection}`,
    shotDirection
      ? `【构图与镜头】${shotDirection}；竖屏短视频构图，主体清晰，核心商品或动作处于视觉中心或黄金分割点，保留字幕安全区。`
      : "【构图与镜头】竖屏短视频构图，主体清晰，核心商品或动作处于视觉中心或黄金分割点，保留字幕安全区。",
    "【光线与色彩】光线、色彩和道具必须强化该槽位的商业目的，饮品类画面优先表现清爽、冰感、通透和购买欲。",
    "【质感与风格】真实商业广告摄影质感，高清、干净、可信，不要廉价促销感。",
    textDirection
      ? `【文字/包装元素】可预留文字区域，后期可叠加：${textDirection}`
      : "【文字/包装元素】预留少量空白区域用于叠加产品名、卖点词或购买引导文案。",
    packagingSuggestion
      ? `【包装建议】${packagingSuggestion}`
      : "【包装建议】保持产品包装、颜色和卖点识别清楚，不要生成无关品牌。",
    "【负面约束】不要复制样例视频中的品牌、人物、Logo 或具体场景；不要生成错误包装、文字乱码、变形产品或无关人物。"
  ].join("\n");
};

const getSlotFallbackVideoPrompt = (
  normalized: Required<V2PipelineRequest>,
  slot: JsonObject,
  slotType: string,
  requiredDuration: number
): string => {
  const productName = normalized.user_request.product_name || "目标产品";
  const goal = normalized.user_request.goal;
  const visualDirection =
    normalizeOptionalString(slot.visual_goal) ||
    normalizeOptionalString(slot.visual_direction) ||
    normalizeOptionalString(slot.description) ||
    normalizeOptionalString(slot.purpose) ||
    "根据输入截图延展出适合该广告槽位的连续动态画面。";
  const copyDirection =
    normalizeOptionalString(slot.copy_direction) ||
    normalizeOptionalString(slot.subtitle_or_vo_direction) ||
    normalizeOptionalString(slot.text_or_voiceover);

  return [
    `【输入图片与对应槽位】使用已有素材抽帧、用户上传图片或用户确认的生成图作为输入图，生成 ${slotType} 槽位短视频；产品为${productName}，广告目标是“${goal}”。`,
    `【景别与构图】保持竖屏 9:16 构图，主体清晰，核心商品或动作位于视觉中心，保留字幕安全区。`,
    `【画面方向】${visualDirection}`,
    "【运镜方式】基于输入图做自然延展，可轻微推进、拉近、平移或稳定微动；不要大幅改变主体身份、产品包装和场景逻辑。",
    "【主体动作】如果输入图有产品，突出产品质感、水珠、冰块、光影或包装细节；如果输入图有人物，只做自然表情、饮用、手部或身体微动作，不新增无关人物。",
    "【环境动态】加入与槽位一致的细微动态，例如水汽、冰块反光、阳光、气泡、背景人群轻微运动或镜头景深变化。",
    copyDirection
      ? `【文字/声音】后期可叠加或配合：${copyDirection}`
      : "【文字/声音】可配合简短音效或后期字幕，画面本身不要生成乱码文字。",
    `【时长与节奏】目标时长约 ${requiredDuration}s，节奏服务于该槽位表达，避免过快导致商品或动作不可读。`,
    "【画质风格】真实商业广告摄影质感，高清、稳定、干净，延续输入图的产品、人物和场景一致性。",
    "【避免事项】不要纯文字生成；必须以输入图为视觉参考。不要生成无关品牌、错误包装、文字乱码、畸形手部或与输入图冲突的人物/场景。"
  ].join("\n");
};

export const buildV2DeterministicMaterialCoverage = async (
  normalized: Required<V2PipelineRequest>,
  fillableArchitecture: JsonObject,
  userMaterialAnalysis: JsonObject
): Promise<V2MaterialCoverage> => {
  const targetDuration = Number(normalized.options.target_duration_seconds || 30);
  const slots = getArchitectureSlots(fillableArchitecture, targetDuration);
  const modelRecords = collectMaterialModelRecords(userMaterialAnalysis);
  const coverageHintsByMaterialRef = collectCoverageHintsByMaterialRef(userMaterialAnalysis);
  for (const [materialRef, slotTypes] of collectCoverageHintsByMaterialRef(fillableArchitecture)) {
    for (const slotType of slotTypes) {
      addCoverageHint(coverageHintsByMaterialRef, materialRef, slotType);
    }
  }
  const aigcPromptsBySlot = collectAigcImagePromptsBySlot(fillableArchitecture);
  const videoPromptsBySlot = collectAigcVideoPromptsBySlot(fillableArchitecture);
  const acceptedDurationShortSlots = new Set(
    normalizeStringArray(normalized.options.accepted_duration_short_slots).map(
      (slot) => normalizeSlotType(slot) || slot
    )
  );

  const materialAssets = await Promise.all(
    normalized.user_materials.map(async (materialRef, index): Promise<JsonObject> => {
      const materialId = `user_material_${String(index + 1).padStart(2, "0")}`;
      const modelRecord = findMaterialModelRecord(modelRecords, materialRef, materialId);
      const localPath = resolveLocalVideoPath(materialRef);
      const durationSeconds = await readLocalVideoDurationSeconds(localPath);
      const modelMaterialId =
        getStringField(modelRecord, ["material_id", "id", "asset_id"]) || materialId;
      const labelMaterialRef = normalizeMaterialReference(materialRef.label);
      const slotTags = Array.from(
        new Set([
          ...getSlotTypeTags(modelRecord),
          ...(coverageHintsByMaterialRef.get(modelMaterialId) || []),
          ...(coverageHintsByMaterialRef.get(materialId) || []),
          ...(labelMaterialRef ? coverageHintsByMaterialRef.get(labelMaterialRef) || [] : [])
        ])
      );
      const contentLabels = Array.from(
        new Set([
          ...slotTags,
          ...normalizeStringArray(modelRecord.visual_tags),
          ...normalizeStringArray(modelRecord.content_tags),
          ...[
            getStringField(modelRecord, [
              "inferred_type",
              "visual_type",
              "material_type",
              "type"
            ])
          ].filter((value): value is string => Boolean(value))
        ])
      );

      return {
        material_id: modelMaterialId,
        input_ref: materialId,
        file_id: materialRef.file_id || extractFileIdFromUploadUri(materialRef.uri),
        uri: materialRef.uri,
        label: materialRef.label || getStringField(modelRecord, ["label", "name"]),
        model_label: getStringField(modelRecord, ["label", "name"]),
        model_description: getStringField(modelRecord, ["description", "notes", "summary"]),
        model_quality: getStringField(modelRecord, ["quality", "confidence_label"]),
        local_path_resolved: Boolean(localPath),
        duration_seconds: durationSeconds,
        duration_status: durationSeconds ? "known" : "unknown",
        usable_duration_seconds: durationSeconds || 0,
        frame_sample_timestamps_seconds: getFrameSampleTimestamps(durationSeconds),
        candidate_slot_types: slotTags,
        content_labels: contentLabels,
        frame_sampling_status: localPath
          ? durationSeconds
            ? "duration_probed_frames_available_for_provider"
            : "duration_probe_failed"
          : "local_file_unresolved"
      };
    })
  );

  const remainingDurations = new Map(
    materialAssets.map((asset) => [
      String(asset.material_id),
      Number(asset.usable_duration_seconds || 0)
    ])
  );

  const slotCoverage = slots.map((slot, index) => {
    const slotType =
      normalizeSlotType(
        slot.slot_type ??
          slot.slot ??
          slot.slot_id ??
          slot.id ??
          slot.slot_name ??
          slot.name
      ) ||
      `slot_${String(index + 1).padStart(2, "0")}`;
    const slotId =
      normalizeOptionalString(slot.slot_id) ||
      normalizeOptionalString(slot.id) ||
      `slot_${String(index + 1).padStart(2, "0")}`;
    const requiredDuration = getRequiredSlotDuration(
      slot,
      index,
      slots.length,
      targetDuration
    );
    let requiredRemaining = requiredDuration;
    const matches: JsonObject[] = [];
    const unknownCandidateRefs: string[] = [];
    const candidateMaterials = materialAssets
      .filter((asset) => normalizeStringArray(asset.candidate_slot_types).includes(slotType))
      .map((asset) => ({
        material_id: asset.material_id,
        label: asset.label,
        model_label: asset.model_label,
        duration_seconds: asset.duration_seconds,
        duration_status: asset.duration_status,
        candidate_slot_types: asset.candidate_slot_types,
        fit_reason: asset.model_description,
        quality: asset.model_quality
      }));

    for (const asset of materialAssets) {
      const materialId = String(asset.material_id);
      const candidateSlotTypes = normalizeStringArray(asset.candidate_slot_types);
      const isCandidate = candidateSlotTypes.includes(slotType);

      if (!isCandidate) {
        continue;
      }

      if (asset.duration_status !== "known") {
        unknownCandidateRefs.push(materialId);
        continue;
      }

      if (requiredRemaining <= 0) {
        continue;
      }

      const remainingDuration = remainingDurations.get(materialId) || 0;
      if (remainingDuration <= 0) {
        continue;
      }

      const allocatedDuration = Number(
        Math.min(requiredRemaining, remainingDuration).toFixed(3)
      );
      remainingDurations.set(
        materialId,
        Number((remainingDuration - allocatedDuration).toFixed(3))
      );
      requiredRemaining = Number((requiredRemaining - allocatedDuration).toFixed(3));
      matches.push({
        material_id: materialId,
        label: asset.label,
        model_label: asset.model_label,
        matched_material_duration: allocatedDuration,
        remaining_material_duration_after_match: remainingDurations.get(materialId)
      });
    }

    const matchedMaterialDuration = Number(
      matches
        .reduce((total, match) => total + Number(match.matched_material_duration || 0), 0)
        .toFixed(3)
    );
    const coverageStatus =
      matchedMaterialDuration >= requiredDuration
        ? "covered"
        : matchedMaterialDuration > 0
          ? "partial"
          : unknownCandidateRefs.length > 0
            ? "duration_unknown"
            : "missing";
    const durationShortAccepted =
      coverageStatus === "partial" &&
      isAcceptedDurationShortSlot(acceptedDurationShortSlots, slotId, slotType);
    const frontendCoverageStatus =
      coverageStatus === "covered" || durationShortAccepted
        ? "fully_matched"
        : coverageStatus === "partial"
          ? "structure_complete_duration_short"
          : "material_insufficient";
    const missingDuration = Number(
      Math.max(0, requiredDuration - matchedMaterialDuration).toFixed(3)
    );
    const aiCompletionRequiredDuration =
      frontendCoverageStatus === "fully_matched" ? 0 : missingDuration || requiredDuration;
    const availableGenerationPaths =
      frontendCoverageStatus === "fully_matched"
        ? []
        : [
            ...(materialAssets.length > 0 ? ["direct_video_from_material_frame"] : []),
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
    const promptRecord = aigcPromptsBySlot.get(slotType);
    const prompt =
      normalizeOptionalString(promptRecord?.prompt) ||
      normalizeOptionalString(promptRecord?.image_prompt) ||
      normalizeOptionalString(promptRecord?.prompt_description);
    const videoPromptRecord = videoPromptsBySlot.get(slotType);
    const videoPrompt =
      normalizeOptionalString(videoPromptRecord?.prompt) ||
      normalizeOptionalString(videoPromptRecord?.video_prompt) ||
      normalizeOptionalString(videoPromptRecord?.prompt_description) ||
      getSlotFallbackVideoPrompt(normalized, slot, slotType, requiredDuration);
    const gapReason =
      coverageStatus === "covered"
        ? undefined
        : matchedMaterialDuration > 0
          ? `已匹配 ${matchedMaterialDuration}s，但该槽位需要 ${requiredDuration}s。`
          : candidateMaterials.length > 0
            ? "存在候选素材，但可分配时长不足或已被前序槽位使用。"
            : "没有可确定匹配到该槽位的用户素材。";
    const directReferenceMaterialIds =
      matches.length > 0
        ? matches.map((material) => String(material.material_id))
        : candidateMaterials.length > 0
          ? candidateMaterials.map((material) => String(material.material_id))
          : materialAssets.map((material) => String(material.material_id));
    const directReferenceMaterialSource = materialAssets.filter((asset) =>
      directReferenceMaterialIds.includes(String(asset.material_id))
    );
    const directVideoReferenceMaterials = directReferenceMaterialSource.map((material) => ({
      material_id: material.material_id,
      label: material.label,
      uri: material.uri,
      duration_seconds: material.duration_seconds,
      frame_sample_timestamps_seconds: material.frame_sample_timestamps_seconds
    }));
    const slotName =
      normalizeOptionalString(slot.slot_name) ||
      normalizeOptionalString(slot.name) ||
      normalizeOptionalString(slot.purpose);
    const visualGoal =
      normalizeOptionalString(slot.visual_goal) ||
      normalizeOptionalString(slot.visual_direction) ||
      normalizeOptionalString(slot.visual_requirements) ||
      normalizeOptionalString(slot.required_visual_type) ||
      normalizeOptionalString(slot.requirement_summary) ||
      normalizeOptionalString(slot.brief) ||
      normalizeOptionalString(slot.description);
    const copyDirection =
      normalizeOptionalString(slot.copy_direction) ||
      normalizeOptionalString(slot.subtitle_or_vo_direction) ||
      normalizeOptionalString(slot.narration_direction) ||
      normalizeOptionalString(slot.caption_direction);
    const frontendCoverageLabel = getFrontendCoverageLabel(frontendCoverageStatus);
    const frontendMaterialSummary = formatFrontendMaterialSummary(
      matches,
      candidateMaterials
    );

    return {
      slot_id:
        slotId,
      slot_type: slotType,
      slot_name: slotName,
      visual_goal: visualGoal,
      copy_direction: copyDirection,
      packaging_suggestions: normalizeOptionalString(slot.packaging_suggestions),
      source_material_refs: normalizeStringArray(
        slot.materials ?? slot.material_ids ?? slot.source_material ?? slot.source_materials
      ),
      required_duration: requiredDuration,
      matched_material_duration: matchedMaterialDuration,
      coverage_status: coverageStatus,
      frontend_coverage_status: frontendCoverageStatus,
      frontend_coverage_label: frontendCoverageLabel,
      frontend_display: {
        migration_result_title: slotName || slotType,
        migration_result_description:
          visualGoal || copyDirection || gapReason || "根据当前广告结构补足该槽位画面。",
        duration_text: formatFrontendSeconds(requiredDuration),
        shot_description: visualGoal || "待补充分镜描述",
        material_summary: frontendMaterialSummary,
        copy: copyDirection || "待生成文案",
        material_status: frontendCoverageLabel
      },
      user_duration_short_decision: durationShortAccepted
        ? "accepted_as_sufficient"
        : coverageStatus === "partial"
          ? "pending"
          : "not_applicable",
      missing_duration: missingDuration,
      ai_completion_required_duration: aiCompletionRequiredDuration,
      available_user_actions: availableUserActions,
      candidate_materials: candidateMaterials,
      assigned_materials: matches,
      matched_materials: matches,
      unknown_duration_candidate_material_refs: unknownCandidateRefs,
      needs_ai_completion: frontendCoverageStatus !== "fully_matched",
      gap_reason: gapReason,
      available_generation_paths: availableGenerationPaths,
      direct_video_reference_materials: directVideoReferenceMaterials,
      recommended_video_prompt: {
        prompt_ref:
          normalizeOptionalString(videoPromptRecord?.prompt_ref) ||
          normalizeOptionalString(videoPromptRecord?.slot_id) ||
          `${slotType}_image_to_video`,
        prompt_source: videoPromptRecord ? "model_or_plan" : "deterministic_slot_fallback",
        prompt_description: normalizeOptionalString(videoPromptRecord?.prompt_description),
        prompt: videoPrompt
      },
      recommended_aigc_prompt: prompt
        ? {
            prompt_ref:
              normalizeOptionalString(promptRecord?.prompt_ref) ||
              normalizeOptionalString(promptRecord?.slot_id) ||
              slotType,
            prompt_source: "model_or_plan",
            prompt_description: normalizeOptionalString(promptRecord?.prompt_description),
            prompt
          }
        : frontendCoverageStatus !== "fully_matched"
          ? {
              prompt_ref: `${slotType}_fallback`,
              prompt_source: "deterministic_slot_fallback",
              prompt_description: "模型没有返回该槽位的专属 prompt，后端基于结构槽位说明生成兜底 prompt。",
              prompt: getSlotFallbackPrompt(normalized, slot, slotType)
            }
          : undefined
    };
  });

  const totalKnownMaterialDuration = Number(
    materialAssets
      .reduce((total, asset) => total + Number(asset.usable_duration_seconds || 0), 0)
      .toFixed(3)
  );
  const totalDurationCoveragePassed = totalKnownMaterialDuration >= targetDuration;
  const allSlotsCovered = slotCoverage.every(
    (coverage) => coverage.coverage_status === "covered"
  );
  const allSlotsFrontendMatched = slotCoverage.every(
    (coverage) => coverage.frontend_coverage_status === "fully_matched"
  );
  const materialsSufficient = allSlotsFrontendMatched;
  const notes = [
    totalDurationCoveragePassed
      ? `已知视频素材总时长 ${totalKnownMaterialDuration}s 覆盖目标成片 ${targetDuration}s。`
      : `已知视频素材总时长 ${totalKnownMaterialDuration}s 小于目标成片 ${targetDuration}s，不能判定素材充足。`,
    allSlotsCovered
      ? "所有结构槽位都有足量已知时长素材覆盖。"
      : allSlotsFrontendMatched
        ? "存在时长不足槽位，但用户已接受当前素材为足够表达。"
        : "至少一个结构槽位缺少足量已知时长素材，需要 AI 补全或补充素材。"
  ];

  return {
    materials_sufficient: materialsSufficient,
    requires_ai_completion: !materialsSufficient,
    target_duration_seconds: targetDuration,
    total_known_material_duration_seconds: totalKnownMaterialDuration,
    hard_constraints: {
      total_duration_coverage_passed: totalDurationCoveragePassed,
      notes
    },
    material_assets: materialAssets,
    slot_coverage: slotCoverage
  };
};

const applyMaterialCoverageToProductionPlan = (
  productionPlan: JsonObject,
  materialCoverage: V2MaterialCoverage
): JsonObject => {
  const canGenerateVideoDirectly =
    getCanGenerateVideoDirectly(productionPlan) &&
    materialCoverage.materials_sufficient;
  const needsUserImageApproval =
    !materialCoverage.materials_sufficient ||
    getNeedsUserImageApproval(productionPlan);

  return {
    ...productionPlan,
    materials_sufficient: materialCoverage.materials_sufficient,
    requires_ai_completion: materialCoverage.requires_ai_completion,
    can_generate_video_directly: canGenerateVideoDirectly,
    needs_user_image_approval: needsUserImageApproval,
    deterministic_material_coverage: materialCoverage,
    material_coverage_notes: materialCoverage.hard_constraints.notes,
    missing_slots: materialCoverage.slot_coverage.filter(
      (slot) => slot.frontend_coverage_status !== "fully_matched"
    )
  };
};

export const attachProductionPromptsToMaterialCoverage = (
  materialCoverage: V2MaterialCoverage,
  productionPlan: JsonObject
): V2MaterialCoverage => {
  const promptsBySlot = collectAigcImagePromptsBySlot(productionPlan);
  const videoPromptsBySlot = collectAigcVideoPromptsBySlot(productionPlan);
  if (promptsBySlot.size === 0 && videoPromptsBySlot.size === 0) {
    return materialCoverage;
  }

  return {
    ...materialCoverage,
    slot_coverage: materialCoverage.slot_coverage.map((slotCoverage) => {
      const slotType = normalizeSlotType(slotCoverage.slot_type);
      const existingPrompt = asJsonObject(slotCoverage.recommended_aigc_prompt);
      const promptRecord =
        existingPrompt.prompt_source === "model_or_plan" || !slotType
          ? undefined
          : promptsBySlot.get(slotType);
      const imagePrompt =
        normalizeOptionalString(promptRecord?.prompt) ||
        normalizeOptionalString(promptRecord?.image_prompt) ||
        normalizeOptionalString(promptRecord?.prompt_description);
      const existingVideoPrompt = asJsonObject(slotCoverage.recommended_video_prompt);
      const videoPromptRecord =
        existingVideoPrompt.prompt_source === "model_or_plan" || !slotType
          ? undefined
          : videoPromptsBySlot.get(slotType);
      const videoPrompt =
        normalizeOptionalString(videoPromptRecord?.prompt) ||
        normalizeOptionalString(videoPromptRecord?.video_prompt) ||
        normalizeOptionalString(videoPromptRecord?.prompt_description);

      return {
        ...slotCoverage,
        recommended_aigc_prompt:
          imagePrompt && promptRecord
            ? {
                prompt_ref:
                  normalizeOptionalString(promptRecord.prompt_ref) ||
                  normalizeOptionalString(promptRecord.slot_id) ||
                  slotType,
                prompt_source: "model_or_plan",
                prompt_description: normalizeOptionalString(promptRecord.prompt_description),
                prompt: imagePrompt
              }
            : slotCoverage.recommended_aigc_prompt,
        recommended_video_prompt:
          videoPrompt && videoPromptRecord
            ? {
                prompt_ref:
                  normalizeOptionalString(videoPromptRecord.prompt_ref) ||
                  normalizeOptionalString(videoPromptRecord.slot_id) ||
                  `${slotType}_image_to_video`,
                prompt_source: "model_or_plan",
                prompt_description: normalizeOptionalString(
                  videoPromptRecord.prompt_description
                ),
                prompt: videoPrompt
              }
            : slotCoverage.recommended_video_prompt
      };
    })
  };
};

const makeFallbackReferenceAnalysis = (
  videoRef: V2VideoRef,
  index: number,
  targetDuration: number,
  reason?: string
): JsonObject => {
  return {
    source: {
      type: "mock",
      reason: reason || "multimodal provider unavailable",
      ref_id: videoRef.file_id || videoRef.uri || `reference_${index}`
    },
    architecture_id: `commercial_ad_reference_${String(index).padStart(2, "0")}`,
    video_summary:
      "降级分析假设该样例是商业广告短视频，只提取可迁移的广告结构，不复制具体内容。",
    target_duration_seconds: targetDuration,
    structure_slots: commercialAdSlots.map((slot, slotIndex) => ({
      slot_id: `ref_${index}_slot_${String(slotIndex + 1).padStart(2, "0")}`,
      slot_type: slot.slot_type,
      time_range: makeSlotDuration(slotIndex, targetDuration),
      role: slot.role,
      reusable_rule: `使用 ${slot.slot_type} 服务这个商业广告目标：${slot.role}。`,
      common_visuals: slot.common_visuals,
      common_packaging: slot.common_packaging
    })),
    rhythm_patterns: [
      "0-3 秒强 Hook",
      "3-11 秒痛点建立和产品亮相",
      "11-22 秒卖点证明和使用过程",
      "22-30 秒效果对比和 CTA"
    ],
    visual_language: [
      "竖屏 9:16 商业广告构图",
      "大字号、易读的文字包装",
      "Hook 和 CTA 段落使用快切",
      "用产品近景证明卖点"
    ],
    transferable_rules: [
      "迁移说服顺序，不迁移样例的具体内容。",
      "优先保证产品可见和卖点可信。",
      "当原始素材较弱时，用字幕、卡片和包装补足表达。"
    ],
    confidence: 0.45
  };
};

const makeFallbackMaterialAnalysis = (
  normalized: Required<V2PipelineRequest>,
  reason?: string
): JsonObject => {
  const fileMaterials = normalized.user_materials.map((material, index) => ({
    material_id: `user_material_${String(index + 1).padStart(2, "0")}`,
    file_id: material.file_id,
    uri: material.uri,
    inferred_type: "video_or_image",
    usable_for_slots: index === 0
      ? ["product_hero", "usage_process"]
      : ["selling_point_proof", "effect_comparison"],
    confidence: 0.55
  }));
  const textMaterials = normalized.text_assets.map((asset, index) => ({
    material_id: asset.asset_id || `text_asset_${String(index + 1).padStart(2, "0")}`,
    type: asset.type,
    content: asset.content,
    usable_for_slots: ["strong_hook", "selling_point_proof", "cta"],
    confidence: 0.7
  }));

  const enoughVisuals = normalized.user_materials.length >= 5;

  return {
    source: {
      type: "mock",
      reason: reason || "multimodal provider unavailable"
    },
    user_request: normalized.user_request,
    material_summary: {
      visual_material_count: normalized.user_materials.length,
      text_asset_count: normalized.text_assets.length,
      enough_for_direct_assembly: enoughVisuals,
      notes: enoughVisuals
        ? "用户素材数量基本足够，可优先生成拼接/剪辑方案。"
        : "用户素材不足，可优先基于现有素材抽帧直接图生视频；如用户希望补充静态画面，再生成图片候选后图生视频。"
    },
    usable_materials: [...fileMaterials, ...textMaterials],
    coverage_by_slot_type: commercialAdSlots.map((slot, index) => ({
      slot_type: slot.slot_type,
      status:
        normalized.user_materials.length > index || normalized.text_assets.length > 0
          ? "partial"
          : "missing",
      material_refs: [
        ...fileMaterials.slice(index, index + 1).map((item) => item.material_id),
        ...textMaterials.slice(0, 1).map((item) => item.material_id)
      ]
    })),
    missing_materials: enoughVisuals
      ? []
      : [
          {
            slot_type: "strong_hook",
            missing: "强视觉开头画面",
            suggested_capture_or_generate: "生成一个突出用户痛点或需求反差的竖屏广告开头图。"
          },
          {
            slot_type: "effect_comparison",
            missing: "使用前后或对比证明画面",
            suggested_capture_or_generate: "生成对比场景图或用包装卡片补足证明。"
          },
          {
            slot_type: "cta",
            missing: "明确购买/咨询/关注动作画面",
            suggested_capture_or_generate: "生成结尾 CTA 卡片或促销信息画面。"
          }
        ],
    risks: [
      "降级模式未真实观看素材内容，只基于输入引用和文本做结构判断。",
      "真实多模态 provider 接通后应以视觉理解结果覆盖该输出。"
    ]
  };
};

const makeFallbackFillableArchitecture = (
  normalized: Required<V2PipelineRequest>,
  referenceVideoAnalyses: JsonObject[],
  userMaterialAnalysis: JsonObject,
  reason?: string
): JsonObject => {
  const targetDuration = Number(normalized.options.target_duration_seconds || 30);

  return {
    source: {
      type: "mock",
      reason: reason || "multimodal provider unavailable"
    },
    architecture_id: `commercial_ad_architecture_${Date.now()}`,
    vertical: "commercial_advertising",
    target_duration_seconds: targetDuration,
    source_reference_ids: referenceVideoAnalyses.map((analysis, index) =>
      normalizeOptionalString(asJsonObject(analysis).architecture_id) ||
      `reference_${index + 1}`
    ),
    user_request: normalized.user_request,
    slots: commercialAdSlots.map((slot, index) => ({
      slot_id: `slot_${String(index + 1).padStart(2, "0")}`,
      slot_type: slot.slot_type,
      time_range: makeSlotDuration(index, targetDuration),
      role: slot.role,
      user_fill_requirements: [
        `围绕主题：${normalized.user_request.goal}`,
        normalized.user_request.product_name
          ? `突出商品：${normalized.user_request.product_name}`
          : "补充商品名称或服务名称",
        normalized.user_request.target_audience
          ? `面向人群：${normalized.user_request.target_audience}`
          : "补充目标人群"
      ],
      visual_direction: slot.common_visuals,
      packaging: slot.common_packaging,
      editable_fields: ["duration", "voiceover_text", "material_ref"],
      locked_fields: ["visual", "shot_description", "packaging"],
      edit_policy: {
        visual_structure_locked: true,
        voiceover_text_editable: true,
        text_to_speech: "future_work"
      }
    })),
    material_fit: asJsonObject(userMaterialAnalysis).coverage_by_slot_type || [],
    decision_points: [
      "如果 product_hero / usage_process 素材足够，优先拼接真实素材。",
      "如果 hook / comparison / CTA 缺素材，可先用已有素材抽帧配合图生视频 prompt 直接生成视频。",
      "补全弹窗不上传缺失素材；如果用户想补充素材，应回到脚本页上传到对应段落文件夹。",
      "如果用户想添加相关图片，由后端先生图候选；用户确认图片后继续使用同一视频 prompt 图生视频。"
    ]
  };
};

const makeFallbackProductionPlan = (
  normalized: Required<V2PipelineRequest>,
  fillableArchitecture: JsonObject,
  userMaterialAnalysis: JsonObject,
  reason?: string
): JsonObject => {
  const targetDuration = Number(normalized.options.target_duration_seconds || 30);
  const canAssemble = normalized.user_materials.length >= 5;
  const productName = normalized.user_request.product_name || "用户商品";
  const audience = normalized.user_request.target_audience || "目标用户";
  const goal = normalized.user_request.goal;
  const missingSlots = asJsonObject(userMaterialAnalysis).missing_materials || [];

  return {
    source: {
      type: "mock",
      reason: reason || "multimodal provider unavailable"
    },
    plan_id: `commercial_ad_production_plan_${Date.now()}`,
    target_duration_seconds: targetDuration,
    can_generate_video_directly: canAssemble,
    needs_user_image_approval: !canAssemble,
    assembly_plan: {
      mode: canAssemble ? "direct_editing_plan" : "hybrid_material_plus_generation",
      notes: canAssemble
        ? "素材数量足够，优先输出剪辑拼接方案。"
        : "素材不足时可基于现有素材抽帧直接图生视频；生图候选作为用户选择的补充路径。",
      timeline_outline: commercialAdSlots.map((slot, index) => ({
        item_id: `outline_${String(index + 1).padStart(2, "0")}`,
        slot_type: slot.slot_type,
        time_range: makeSlotDuration(index, targetDuration),
        visual_source:
          canAssemble || index < normalized.user_materials.length
            ? "user_material"
            : "material_frame_or_uploaded_or_generated_image_then_video",
        editing_instruction: `该段用于完成广告目标：${slot.role}。`
      }))
    },
    missing_slots: missingSlots,
    generation_prompt_package: {
      prompt_package_id: `prompt_package_${Date.now()}`,
      language: "zh-CN",
      aspect_ratio: "9:16",
      commercial_category: "commercial_advertising",
      product_name: productName,
      target_audience: audience,
      goal,
      image_prompt_candidates: [
        {
          prompt_ref: "hook_image",
          slot_type: "strong_hook",
          prompt: [
            `【基础设定】竖屏 9:16 商业广告开头关键帧，服务于“${goal}”。`,
            "【候选图要求】请为该槽位生成 4 张候选图供用户选择，四张图必须围绕同一个具体痛点主题和同一产品设定，只在构图、光线、景别或背景细节上有差异。",
            `【主体/产品】面向“${audience}”，画面需要暗示${productName}即将作为解决方案出现，但不要直接复制样例广告品牌或场景。`,
            "【场景环境】选择一个最符合用户素材和产品的真实生活痛点场景，例如炎热疲惫后的冰爽需求；不要同时列出多个互斥场景。如果用户素材里没有人物，优先用环境、物品、手部动作或局部状态表达痛点。",
            "【构图与镜头】中近景或特写构图，主体位于视觉中心，背景保留少量环境信息，方便后续叠加大字标题；如需人物出镜，人物形象应匹配目标人群和产品定位。",
            "【光线与色彩】痛点侧使用偏暖、偏压迫的色调；为后续产品转场预留冷色或高亮对比。",
            "【质感与风格】写实商业广告质感，画面清晰，细节可信，有强停留感。",
            "【画面内容】突出用户正在面临的购买风险、使用痛点或强需求，让观众 1 秒内理解问题；有用户主角素材时尽量还原主角形象，没有人物素材时不要无故新增完整人物。",
            "【文字/包装元素】可预留顶部或中心位置放置大字 Hook，例如“你也遇到过吗？”“先别急着买”。",
            "【负面约束】不要出现样例视频中的品牌、人物、Logo、具体场景；不要生成低清、杂乱或信息过多的画面。"
          ].join("\n")
        },
        {
          prompt_ref: "product_hero_image",
          slot_type: "product_hero",
          prompt: [
            `【基础设定】竖屏 9:16 商品主视觉图，用于 15-30 秒商业广告中的产品亮相槽位。`,
            "【候选图要求】请为该槽位生成 4 张候选图供用户选择，四张图必须保持同一产品、同一包装和同一广告意图，只在产品角度、光线、背景和景别上有差异。",
            `【主体/产品】画面中心是${productName}，产品包装清晰可辨，核心卖点区域留有可读空间。`,
            "【场景环境】使用干净、商业化的棚拍或极简环境，可结合冰块、水珠、光效、材质、道具强化产品属性。",
            "【构图与镜头】产品居中或略偏中心，近景/特写镜头，背景虚化或简化，确保产品是第一视觉焦点。",
            "【光线与色彩】明亮但不过曝，使用符合品类的主色调，并用高光边缘勾勒包装轮廓。",
            "【质感与风格】高级商品摄影、真实材质、清晰细节、适合电商和短视频广告使用。",
            "【画面内容】突出产品质感、卖点和购买欲，不出现无关人物或复杂背景。",
            "【文字/包装元素】可预留一处空白用于叠加产品名、卖点词或价格/优惠信息。",
            "【负面约束】不要复刻样例视频构图；不要让产品变形、Logo 错乱、文字乱码；不要过度艺术化导致商品不清晰。"
          ].join("\n")
        },
        {
          prompt_ref: "comparison_image",
          slot_type: "effect_comparison",
          prompt: [
            "【基础设定】竖屏 9:16 效果对比广告图，用于商业广告中的证明槽位。",
            "【候选图要求】请为该槽位生成 4 张候选图供用户选择，四张图必须保持同一对比逻辑、同一主体和同一产品设定，只在分屏形式、构图和光线氛围上有差异。",
            `【主体/产品】围绕${productName}带来的改善结果进行表达，产品可出现在改善后的画面中。`,
            "【场景环境】使用左右分屏、前后对比或同一人物状态变化，清楚表达使用前后的差异。",
            "【构图与镜头】左侧/前段表现问题状态，右侧/后段表现改善状态，中间用清晰分割线或转场视觉连接。",
            "【光线与色彩】问题侧可偏暗、偏暖或低饱和；改善侧更明亮、清爽、干净。",
            "【质感与风格】现代商业广告对比图，画面简洁，信息强烈但不廉价。",
            "【画面内容】突出一个明确改善点，不堆砌多个复杂信息。",
            "【文字/包装元素】可预留“Before / After”或中文对比标签位置，也可加入关键词高亮。",
            "【负面约束】不要夸大医疗、功效或绝对化承诺；不要让画面像低质促销海报。"
          ].join("\n")
        }
      ],
      video_prompt_candidates: [
        {
          prompt_ref: "hook_image_to_video",
          input_image_ref: "hook_image",
          prompt: [
            "【输入图片与对应槽位】使用用户确认的 hook_image，生成强 Hook 槽位短视频。",
            "【景别与构图】保持竖屏构图，主体始终位于画面中心或黄金分割点，保留字幕安全区。",
            "【运镜方式】镜头 3 秒内轻微推进或快速推近，开头 0.5 秒建立环境，随后加速靠近主体。",
            "【主体动作】强化用户痛点或需求瞬间，例如手部动作、物体震动、水珠滑落、环境变化等；只有在输入图片或结构需要人物时，才生成人物表情变化。",
            "【环境动态】加入轻微光影变化、热浪、水汽、粒子或速度线，服务于画面情绪。",
            "【转场方式】结尾用闪白、快速模糊或硬切，方便接到产品亮相镜头。",
            "【声音/音效】建议加入短促冲击音、环境声或动作音效，不需要完整配乐。",
            "【时长与节奏】总时长约 3 秒，前 1 秒吸引注意，后 2 秒制造转场期待。",
            "【画质风格】商业广告质感，清晰、稳定、节奏强。",
            "【避免事项】不要新增无关品牌或复杂人物；用户素材没有人物时，不要无故新增完整人物；不要让画面变形；不要复制样例视频具体镜头。"
          ].join("\n")
        },
        {
          prompt_ref: "product_hero_image_to_video",
          input_image_ref: "product_hero_image",
          prompt: [
            "【输入图片与对应槽位】使用用户确认的 product_hero_image，生成产品亮相槽位短视频。",
            "【景别与构图】产品保持居中清晰，包装和核心卖点区域不能被遮挡。",
            "【运镜方式】4 秒平稳推进或轻微环绕，镜头运动要高级、克制，不要剧烈摇晃。",
            "【主体动作】产品可轻微旋转，水珠缓慢滑落，冰块或道具产生细微动态。",
            "【环境动态】背景光效、水汽、气泡或反射缓慢变化，突出质感。",
            "【转场方式】开头从上一镜头硬切或光效切入，结尾保留 0.3 秒稳定画面方便叠加卖点文字。",
            "【声音/音效】建议加入清脆开瓶声、冰块碰撞声、水珠或气泡声。",
            "【时长与节奏】总时长约 4 秒，节奏稳中有动，服务于产品记忆。",
            "【画质风格】高端商品广告、真实摄影、细节清晰、光影干净。",
            "【避免事项】不要让产品包装文字扭曲；不要生成额外品牌；不要把背景做得比产品更抢眼。"
          ].join("\n")
        }
      ]
    },
    guardrails: [
      "AIGC prompt 只描述新商品需要的画面，不复制样例视频内容。",
      "禁止纯文字直接生视频；必须使用已有素材抽帧、用户上传图片或用户确认的生成图作为图生视频输入。"
    ]
  };
};

const callMultimodalWithFallback = async (
  task: string,
  payload: JsonObject,
  allowFallback: boolean,
  fallbackFactory: (reason?: string) => JsonObject
): Promise<{ output: JsonObject; fallbackReason?: string }> => {
  try {
    return {
      output: await requestMultimodalJson(task, v2SystemPrompt, payload)
    };
  } catch (error) {
    if (!allowFallback) {
      throw error;
    }

    const fallbackReason = sanitizeFallbackReason(error);
    return {
      output: fallbackFactory(fallbackReason),
      fallbackReason
    };
  }
};

const makeFallbackImageCandidateResponse = (
  promptPackage: JsonObject,
  count: number
): JsonObject => {
  const promptCandidates = Array.isArray(promptPackage.image_prompt_candidates)
    ? promptPackage.image_prompt_candidates
    : [];

  return {
    source: {
      type: "mock",
      reason: "图片生成 provider 未配置或调用失败"
    },
    data: Array.from({ length: count }, (_, index) => {
      const promptRecord = asJsonObject(
        promptCandidates[index % Math.max(1, promptCandidates.length)]
      );
      const prompt =
        normalizeOptionalString(promptRecord.prompt) ||
        "生成一张竖屏商业广告关键画面，突出商品、用户痛点和清晰包装信息。";

      return {
        prompt_ref:
          normalizeOptionalString(promptRecord.prompt_ref) ||
          `image_prompt_${String(index + 1).padStart(2, "0")}`,
        prompt,
        uri: undefined,
        note: "这是 mock 图片候选。配置真实图片生成 provider 后会返回真实图片 URI。"
      };
    })
  };
};

const makeFallbackImageToVideoResponse = (
  payload: V2ImageToVideoRequest,
  sourceImageUri?: string
): JsonObject => {
  return {
    source: {
      type: "mock",
      provider: config.providers.v2.video.provider,
      reason: "视频生成 provider 未配置或调用失败"
    },
    job_id: `mock_video_job_${Date.now()}`,
    status: "mock_ready",
    input: {
      image_uri: sourceImageUri,
      prompt: payload.video_prompt,
      duration_seconds: payload.duration_seconds || 5,
      aspect_ratio: payload.aspect_ratio || "9:16",
      generation_mode: payload.generation_mode || "generated_image"
    },
    note:
      "这是 mock 图生视频任务响应。配置真实视频生成 provider 后才会返回真实生成任务或视频结果。"
  };
};

export const runV2Pipeline = async (
  payload: V2PipelineRequest
): Promise<V2PipelineResult> => {
  const normalized = normalizeRequest(payload);
  const targetDuration = Number(normalized.options.target_duration_seconds || 30);
  const adaptiveSlotPlanningRules = getAdaptiveSlotPlanningRules(targetDuration);
  const allowFallback = normalized.options.allow_fallback !== false;
  const fallbackReasons: string[] = [];

  const referenceAnalysisResults = await Promise.all(
    normalized.reference_videos.map((videoRef, index) =>
      callMultimodalWithFallback(
        "analyze_reference_video",
        {
          vertical: "commercial_advertising",
          target_duration_seconds: targetDuration,
          reference_index: index + 1,
          video: videoRef,
          reusable_slot_type_reference: commercialAdSlots.map((slot) => slot.slot_type),
          adaptive_slot_planning_rules: adaptiveSlotPlanningRules,
          instruction:
            "阅读并理解这个商业广告样例视频。请用中文返回广告结构槽位、节奏、视觉/包装风格、说服逻辑、内容逻辑和可迁移模式。reusable_slot_type_reference 只是可复用槽位类型参考，不代表新视频必须保留所有槽位。不要复制样例视频的具体内容。所有图片生成 prompt 和图生视频 prompt 必须中文。"
        },
        allowFallback,
        (reason) =>
          makeFallbackReferenceAnalysis(videoRef, index + 1, targetDuration, reason)
      )
    )
  );
  const referenceVideoAnalyses = referenceAnalysisResults.map((result) => result.output);
  fallbackReasons.push(
    ...referenceAnalysisResults
      .map((result) => result.fallbackReason)
      .filter((reason): reason is string => Boolean(reason))
  );

  const userMaterialAnalysisResult = await callMultimodalWithFallback(
    "analyze_user_request_and_materials",
    {
      vertical: "commercial_advertising",
      target_duration_seconds: targetDuration,
      reusable_slot_type_reference: commercialAdSlots.map((slot) => slot.slot_type),
      adaptive_slot_planning_rules: adaptiveSlotPlanningRules,
      user_request: normalized.user_request,
      user_materials: normalized.user_materials,
      text_assets: normalized.text_assets,
      instruction:
        "分析用户想要什么，以及用户素材能支撑一个商业广告短视频中的哪些槽位。reusable_slot_type_reference 只是槽位类型参考；请根据目标时长和素材质量判断哪些槽位应该合并、保留或舍弃。请用中文返回可用素材、弱素材、缺失素材、素材到槽位的建议。所有说明和后续 prompt 必须中文。"
    },
    allowFallback,
    (reason) => makeFallbackMaterialAnalysis(normalized, reason)
  );
  const userMaterialAnalysis = userMaterialAnalysisResult.output;
  if (userMaterialAnalysisResult.fallbackReason) {
    fallbackReasons.push(userMaterialAnalysisResult.fallbackReason);
  }

  const fillableArchitectureResult = await callMultimodalWithFallback(
    "synthesize_fillable_architecture",
    {
      vertical: "commercial_advertising",
      target_duration_seconds: targetDuration,
      reusable_slot_type_reference: commercialAdSlots.map((slot) => slot.slot_type),
      adaptive_slot_planning_rules: adaptiveSlotPlanningRules,
      user_request: normalized.user_request,
      reference_video_analyses: referenceVideoAnalyses,
      user_material_analysis: userMaterialAnalysis,
      instruction:
        "综合多个商业广告样例的结构，生成一个适合用户新广告的可填写结构。必须服从 adaptive_slot_planning_rules：目标时长越短，越应该合并或舍弃非必要模块，不能机械输出7个槽位。每个槽位应有足够时长表达清楚，整体逻辑必须完整。请用中文返回每个可编辑槽位、时长、画面方向、字幕/口播方向、包装建议、需要用户填入或补充的内容。所有生成 prompt 必须中文。"
    },
    allowFallback,
    (reason) =>
      makeFallbackFillableArchitecture(
        normalized,
        referenceVideoAnalyses,
        userMaterialAnalysis,
        reason
      )
  );
  const fillableArchitecture = fillableArchitectureResult.output;
  if (fillableArchitectureResult.fallbackReason) {
    fallbackReasons.push(fillableArchitectureResult.fallbackReason);
  }

  const baseMaterialCoverage = await buildV2DeterministicMaterialCoverage(
    normalized,
    fillableArchitecture,
    userMaterialAnalysis
  );

  const productionPlanResult = await callMultimodalWithFallback(
    "plan_assembly_or_generation",
    {
      vertical: "commercial_advertising",
      target_duration_seconds: targetDuration,
      user_request: normalized.user_request,
      adaptive_slot_planning_rules: adaptiveSlotPlanningRules,
      fillable_architecture: fillableArchitecture,
      user_material_analysis: userMaterialAnalysis,
      deterministic_material_coverage: baseMaterialCoverage,
      detailed_generation_prompt_requirements: detailedGenerationPromptRequirements,
      instruction:
        "判断现有用户素材是否足够生成商业广告时，必须优先服从 deterministic_material_coverage：只要 materials_sufficient 为 false，就不能输出可直接成片，必须为未覆盖或时长不足槽位规划 AI 补全或补充素材。新的补全链路有三种：1. 默认可直接使用已有用户素材的抽帧截图 + 图生视频 prompt 生成视频；2. 用户上传相关图片后，用该图片 + 同一图生视频 prompt 生成视频；3. 用户选择先生成图片候选时，再输出图片生成 prompt，用户确认图片后用同一图生视频 prompt 生成视频。禁止规划纯文字直接生视频。请为每个需补全槽位优先返回详细的图生视频 prompt，并可选返回图片生成 prompt。所有 prompt 必须描述新商品和新场景，不要复制样例视频内容。所有图片生成 prompt 和图生视频 prompt 必须按 detailed_generation_prompt_requirements 中的章节组织，内容要像专业视频提示词一样详细。图片生成 prompt 要明确说明为同一槽位生成 4 张候选图供用户选择，且 4 张图必须是同一个具体主题、同一产品设定、同一场景逻辑下的四种变体，只能在构图、光线、景别、镜头角度或背景细节上有差异。不要用“例如 1/2/3/4”列出多个互斥主体或场景，避免模型把四张候选图生成成四个不同主题。特别注意产品和人物规则：如果用户素材里已有产品、包装、品牌视觉或主角人物，后续生成必须尽量还原它们，不能写“不要出现完整产品”“不要出现人物”等与用户素材冲突的负面约束；这类限制只能表达为“不要出现无关产品/无关人物/无关品牌”。如果用户素材里没有人物且槽位不强制人物出现，则不要凭空生成人物，优先展示产品、道具、场景、手部动作或包装画面；如果必须新增人物，需详细描述符合产品设定和目标人群的人物样貌、穿着、状态和动作。"
    },
    allowFallback,
    (reason) =>
      makeFallbackProductionPlan(
        normalized,
        fillableArchitecture,
        userMaterialAnalysis,
        reason
      )
  );
  const productionAwareMaterialCoverage = await buildV2DeterministicMaterialCoverage(
    normalized,
    fillableArchitecture,
    {
      ...userMaterialAnalysis,
      production_plan: productionPlanResult.output
    }
  );
  const materialCoverage = attachProductionPromptsToMaterialCoverage(
    productionAwareMaterialCoverage,
    productionPlanResult.output
  );
  const productionPlan = applyMaterialCoverageToProductionPlan(
    productionPlanResult.output,
    materialCoverage
  );
  if (productionPlanResult.fallbackReason) {
    fallbackReasons.push(productionPlanResult.fallbackReason);
  }

  const imageCandidates =
    normalized.options.generate_image_candidates === true
      ? await (async () => {
          const count = Number(
            normalized.options.image_candidate_count || defaultImageCandidateCount
          );
          try {
            const referenceImages = await collectReferenceImagesForGeneration(
              normalized.user_materials,
              count
            );

            return normalizeImageCandidates(
              await requestImageCandidates(
                getPromptPackage(productionPlan),
                count,
                referenceImages
              ),
              count
            );
          } catch (error) {
            if (!allowFallback) {
              throw error;
            }

            fallbackReasons.push(sanitizeFallbackReason(error));
            return normalizeImageCandidates(
              makeFallbackImageCandidateResponse(getPromptPackage(productionPlan), count),
              count
            );
          }
        })()
      : undefined;

  return {
    id: `v2_pipeline_${Date.now()}`,
    version: "2.0.0",
    created_at: new Date().toISOString(),
    source: {
      type: "api_first_v2",
      multimodal_provider: config.providers.v2.multimodal.provider,
      image_provider: imageCandidates ? config.providers.v2.image.provider : undefined,
      video_provider: config.providers.v2.video.provider,
      fallback_used: fallbackReasons.length > 0,
      fallback_reason: fallbackReasons[0]
    },
    input: {
      reference_video_count: normalized.reference_videos.length,
      user_material_count: normalized.user_materials.length,
      text_asset_count: normalized.text_assets.length
    },
    stages: {
      reference_video_analyses: referenceVideoAnalyses,
      user_material_analysis: userMaterialAnalysis,
      fillable_architecture: fillableArchitecture,
      material_coverage: materialCoverage,
      production_plan: productionPlan,
      image_candidates: imageCandidates
    },
    summary: {
      status: "completed",
      needs_user_image_approval: getNeedsUserImageApproval(productionPlan),
      can_generate_video_directly: getCanGenerateVideoDirectly(productionPlan),
      target_duration_seconds: targetDuration,
      notes:
        fallbackReasons.length > 0
          ? "V2 已使用降级输出完成。请确认真实 provider adapter 和密钥配置后，再将生成媒体视为真实结果。"
          : "V2 API-first 链路已完成。需补全槽位可直接用已有素材抽帧调用图生视频；用户选择补充图片时，再生成或上传图片后调用同一图生视频 prompt。"
    }
  };
};

export const generateV2ImageCandidates = async (
  payload: V2ImageCandidateRequest
): Promise<JsonObject> => {
  const directPrompt =
    normalizeOptionalString(payload.prompt) || normalizeOptionalString(payload.image_prompt);
  const promptPackage =
    payload.prompt_package && typeof payload.prompt_package === "object"
      ? payload.prompt_package
      : directPrompt
        ? {
            prompt: directPrompt
          }
        : undefined;

  if (!promptPackage) {
    throw new V2PipelineInputError("prompt or prompt_package is required");
  }

  const count = Math.max(
    1,
    Math.min(maxImageCandidateCount, Number(payload.count || defaultImageCandidateCount))
  );
  const allowFallback = payload.allow_fallback !== false;

  try {
    const referenceVideoRefs = [
      ...normalizeVideoRefs(payload.reference_videos, [], "user_material"),
      ...normalizeReferenceVideoUris(payload.reference_video_uris)
    ];
    const referenceImages = [
      ...normalizeReferenceImages(payload.reference_images),
      ...(await collectReferenceImagesForGeneration(referenceVideoRefs, count))
    ];

    return await requestImageCandidates(promptPackage, count, referenceImages);
  } catch (error) {
    if (!allowFallback) {
      throw error;
    }

    return {
      ...makeFallbackImageCandidateResponse(promptPackage, count),
      fallback_reason: sanitizeFallbackReason(error)
    };
  }
};

const normalizeImageToVideoSourceVideos = (payload: V2ImageToVideoRequest): V2VideoRef[] => {
  const videoRefs: V2VideoRef[] = [];

  if (payload.source_video_uri) {
    videoRefs.push({
      uri: payload.source_video_uri,
      role: "user_material",
      label: "source_video"
    });
  }

  if (payload.source_video) {
    videoRefs.push({
      ...payload.source_video,
      role: payload.source_video.role || "user_material"
    });
  }

  if (payload.source_material) {
    videoRefs.push({
      ...payload.source_material,
      role: payload.source_material.role || "user_material"
    });
  }

  return videoRefs;
};

const resolveImageToVideoSourceImage = async (
  payload: V2ImageToVideoRequest
): Promise<JsonObject> => {
  const explicitImageUri =
    normalizeOptionalString(payload.approved_image_uri) ||
    normalizeOptionalString(payload.source_image_uri) ||
    normalizeOptionalString(payload.image_uri);

  if (explicitImageUri) {
    return {
      image_uri: explicitImageUri,
      source_type:
        payload.generation_mode === "uploaded_image"
          ? "uploaded_image"
          : payload.generation_mode === "generated_image"
            ? "generated_image"
            : "explicit_image"
    };
  }

  const sourceVideoRefs = normalizeImageToVideoSourceVideos(payload);
  if (sourceVideoRefs.length === 0) {
    throw new V2PipelineInputError(
      "source image is required: pass approved_image_uri/source_image_uri, or pass source_video_uri/source_material so the backend can extract a frame"
    );
  }

  const frames = await collectV2ReferenceFramesFromVideos(sourceVideoRefs, 1);
  const sourceFrame = frames[0];
  if (!sourceFrame) {
    throw new V2PipelineInputError(
      "failed to extract source frame from existing material; direct video generation requires a readable local material video"
    );
  }

  return {
    image_uri: sourceFrame.data_url,
    source_type: "material_frame",
    source_frame: {
      frame_id: sourceFrame.frame_id,
      source_uri: sourceFrame.source_uri,
      source_label: sourceFrame.source_label,
      time_seconds: sourceFrame.time_seconds,
      mime_type: sourceFrame.mime_type
    }
  };
};

export const generateV2ImageToVideo = async (
  payload: V2ImageToVideoRequest
): Promise<JsonObject> => {
  if (!payload.video_prompt) {
    throw new V2PipelineInputError("video_prompt is required");
  }

  const sourceImage = await resolveImageToVideoSourceImage(payload);
  const requestPayload = {
    image_uri: sourceImage.image_uri,
    prompt: payload.video_prompt,
    duration_seconds: payload.duration_seconds || 5,
    aspect_ratio: payload.aspect_ratio || "9:16",
    camera_fixed: payload.camera_fixed,
    watermark: payload.watermark,
    generation_mode: payload.generation_mode || sourceImage.source_type,
    source_frame: sourceImage.source_frame
  };
  const allowFallback = payload.allow_fallback !== false;

  try {
    const providerResponse = await requestImageToVideo(requestPayload);
    saveImageToVideoAutoTrimContext(providerResponse, payload, requestPayload);
    return providerResponse;
  } catch (error) {
    if (!allowFallback) {
      throw error;
    }

    return {
      ...makeFallbackImageToVideoResponse(payload, normalizeOptionalString(sourceImage.image_uri)),
      fallback_reason: sanitizeFallbackReason(error)
    };
  }
};

const generatedVideoReviewDir = path.resolve(
  process.cwd(),
  "../../outputs/v2_generated_video_review"
);
const generatedVideoTaskContextDir = path.resolve(
  process.cwd(),
  "../../outputs/v2_generated_video_tasks"
);
const finalAssemblyDir = path.resolve(process.cwd(), "../../outputs/v2_final_assembly");

const ensureGeneratedVideoReviewDir = (): void => {
  fs.mkdirSync(generatedVideoReviewDir, { recursive: true });
};

const ensureGeneratedVideoTaskContextDir = (): void => {
  fs.mkdirSync(generatedVideoTaskContextDir, { recursive: true });
};

const ensureFinalAssemblyDir = (): void => {
  fs.mkdirSync(finalAssemblyDir, { recursive: true });
};

const isHttpUrl = (value: string): boolean => /^https?:\/\//iu.test(value);

const normalizeNumberField = (value: unknown): number | undefined => {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : undefined;
};

const getGeneratedVideoDurationSeconds = async (videoPath: string): Promise<number> => {
  const probeResult = await runFFprobe(videoPath);
  const videoStream = probeResult.streams?.find(
    (stream) => stream.codec_type === "video"
  );
  const duration = Number(videoStream?.duration || probeResult.format?.duration);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new V2PipelineInputError("generated video duration is missing or invalid");
  }

  return Number(duration.toFixed(3));
};

const materializeGeneratedVideo = async (videoUri: string): Promise<string> => {
  if (videoUri.startsWith("/") && fs.existsSync(videoUri)) {
    return videoUri;
  }

  if (!isHttpUrl(videoUri)) {
    throw new V2PipelineInputError("video_uri must be an existing local path or HTTP URL");
  }

  ensureGeneratedVideoReviewDir();
  const videoPath = path.join(
    generatedVideoReviewDir,
    `generated_video_${crypto.randomUUID()}.mp4`
  );
  const response = await fetch(videoUri);

  if (!response.ok) {
    throw new V2PipelineInputError(`failed to download generated video: ${response.status}`);
  }

  fs.writeFileSync(videoPath, Buffer.from(await response.arrayBuffer()));
  return videoPath;
};

const materializeAssemblyVideo = async (
  videoUri: string,
  workDir: string,
  index: number
): Promise<string> => {
  if (videoUri.startsWith("/") && fs.existsSync(videoUri)) {
    return videoUri;
  }

  const trimmedVideoRoutePrefix = "/api/v2/generation/trimmed-videos/";
  if (videoUri.startsWith(trimmedVideoRoutePrefix)) {
    const filename = decodeURIComponent(videoUri.slice(trimmedVideoRoutePrefix.length));
    const videoPath = findV2GeneratedVideoReviewFile(filename);
    if (videoPath) {
      return videoPath;
    }
  }

  const uploadedVideoRoutePrefix = "/api/upload/files/";
  if (videoUri.startsWith(uploadedVideoRoutePrefix)) {
    const fileId = videoUri.slice(uploadedVideoRoutePrefix.length);
    const videoPath = findUploadedVideoById(fileId);
    if (videoPath) {
      return videoPath;
    }
  }

  if (!isHttpUrl(videoUri)) {
    throw new V2PipelineInputError(
      `slot video_uri must be an existing local path, HTTP URL, or known API media URL: slot ${index + 1}`
    );
  }

  const videoPath = path.join(
    workDir,
    `source_${String(index + 1).padStart(2, "0")}.mp4`
  );
  const response = await fetch(videoUri);

  if (!response.ok) {
    throw new V2PipelineInputError(
      `failed to download slot ${index + 1} video: ${response.status}`
    );
  }

  fs.writeFileSync(videoPath, Buffer.from(await response.arrayBuffer()));
  return videoPath;
};

const getTrimTime = (analysis: JsonObject, fields: string[]): number | undefined => {
  for (const field of fields) {
    const directValue = normalizeNumberField(analysis[field]);
    if (directValue !== undefined) {
      return directValue;
    }

    const nestedValue = normalizeNumberField(
      asJsonObject(analysis.recommended_segment)[field] ??
        asJsonObject(analysis.trim_recommendation)[field] ??
        asJsonObject(analysis.recommended_trim)[field]
    );
    if (nestedValue !== undefined) {
      return nestedValue;
    }
  }

  return undefined;
};

const makeFallbackGeneratedVideoTrimAnalysis = (
  targetDurationSeconds: number,
  videoDurationSeconds: number,
  reason?: string
): JsonObject => {
  const endSeconds = Number(
    Math.min(targetDurationSeconds, videoDurationSeconds).toFixed(3)
  );

  return {
    source: {
      type: "deterministic_fallback",
      reason: reason || "视频理解模型不可用，使用从开头截取的保守策略。"
    },
    recommended_start_seconds: 0,
    recommended_end_seconds: endSeconds,
    recommended_duration_seconds: endSeconds,
    confidence: 0.3,
    quality_status: "needs_manual_review",
    reason:
      "未能完成视频理解评审，默认选择开头连续片段。建议人工检查后再进入最终剪辑。"
  };
};

const normalizeTrimRecommendation = (
  rawAnalysis: JsonObject,
  targetDurationSeconds: number,
  videoDurationSeconds: number
): JsonObject => {
  const boundedTargetDuration = Math.max(
    0.1,
    Math.min(targetDurationSeconds, videoDurationSeconds)
  );
  const rawStart =
    getTrimTime(rawAnalysis, [
      "recommended_start_seconds",
      "start_seconds",
      "trim_start_seconds",
      "start_time_seconds"
    ]) ?? 0;
  const maxStart = Math.max(0, videoDurationSeconds - boundedTargetDuration);
  const startSeconds = Number(Math.max(0, Math.min(rawStart, maxStart)).toFixed(3));
  const rawEnd =
    getTrimTime(rawAnalysis, [
      "recommended_end_seconds",
      "end_seconds",
      "trim_end_seconds",
      "end_time_seconds"
    ]) ?? startSeconds + boundedTargetDuration;
  const minimumEnd = startSeconds + boundedTargetDuration;
  const endSeconds = Number(
    Math.min(
      videoDurationSeconds,
      Math.max(minimumEnd, rawEnd)
    ).toFixed(3)
  );
  const normalizedDuration = Number((endSeconds - startSeconds).toFixed(3));

  return {
    ...rawAnalysis,
    recommended_start_seconds: startSeconds,
    recommended_end_seconds: endSeconds,
    recommended_duration_seconds: normalizedDuration,
    target_duration_seconds: targetDurationSeconds,
    source_video_duration_seconds: videoDurationSeconds,
    trim_normalized_by_backend: true
  };
};

const trimGeneratedVideo = async (
  sourceVideoPath: string,
  startSeconds: number,
  durationSeconds: number
): Promise<string> => {
  ensureGeneratedVideoReviewDir();
  const outputPath = path.join(
    generatedVideoReviewDir,
    `trimmed_segment_${crypto.randomUUID()}.mp4`
  );
  await runFFmpeg(
    [
      "-y",
      "-ss",
      String(startSeconds),
      "-i",
      sourceVideoPath,
      "-t",
      String(durationSeconds),
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      outputPath
    ],
    [
      { path: sourceVideoPath, replacement: "[generated video]" },
      { path: outputPath, replacement: "[trimmed video]" }
    ]
  );

  return outputPath;
};

const normalizeTaskId = (value: unknown): string | undefined => {
  return normalizeOptionalString(value)?.replace(/[^a-zA-Z0-9_-]/gu, "");
};

const getGeneratedVideoTaskContextPath = (taskId: string): string =>
  path.join(generatedVideoTaskContextDir, `${taskId}.json`);

export const findV2GeneratedVideoReviewFile = (
  filename: string
): string | undefined => {
  const safeFilename = path.basename(filename);
  if (!safeFilename || !safeFilename.endsWith(".mp4")) {
    return undefined;
  }

  const videoPath = path.join(generatedVideoReviewDir, safeFilename);
  return fs.existsSync(videoPath) ? videoPath : undefined;
};

export const findV2FinalAssemblyVideoFile = (
  filename: string
): string | undefined => {
  const safeFilename = path.basename(filename);
  if (!safeFilename || !safeFilename.endsWith(".mp4")) {
    return undefined;
  }

  const videoPath = path.join(finalAssemblyDir, safeFilename);
  return fs.existsSync(videoPath) ? videoPath : undefined;
};

const getGeneratedVideoPublicUrl = (videoPath?: string): string | undefined => {
  if (!videoPath || path.dirname(videoPath) !== generatedVideoReviewDir) {
    return undefined;
  }

  return `/api/v2/generation/trimmed-videos/${encodeURIComponent(
    path.basename(videoPath)
  )}`;
};

const getFinalAssemblyPublicUrl = (videoPath?: string): string | undefined => {
  if (!videoPath || path.dirname(videoPath) !== finalAssemblyDir) {
    return undefined;
  }

  return `/api/v2/assembly/final-videos/${encodeURIComponent(path.basename(videoPath))}`;
};

const readGeneratedVideoTaskContext = (taskId: string): JsonObject | undefined => {
  const contextPath = getGeneratedVideoTaskContextPath(taskId);
  if (!fs.existsSync(contextPath)) {
    return undefined;
  }

  return JSON.parse(fs.readFileSync(contextPath, "utf8")) as JsonObject;
};

const writeGeneratedVideoTaskContext = (
  taskId: string,
  context: JsonObject
): void => {
  ensureGeneratedVideoTaskContextDir();
  fs.writeFileSync(
    getGeneratedVideoTaskContextPath(taskId),
    `${JSON.stringify(context, null, 2)}\n`
  );
};

const getVideoUrlFromTaskResult = (taskResult: JsonObject): string | undefined => {
  return (
    normalizeOptionalString(asJsonObject(taskResult.content).video_url) ||
    normalizeOptionalString(taskResult.video_url) ||
    normalizeOptionalString(taskResult.url)
  );
};

const saveImageToVideoAutoTrimContext = (
  providerResponse: JsonObject,
  payload: V2ImageToVideoRequest,
  requestPayload: JsonObject
): void => {
  const taskId = normalizeTaskId(providerResponse.id ?? providerResponse.task_id);
  if (!taskId || payload.auto_trim_review === false) {
    return;
  }

  const targetDurationSeconds = normalizeNumberField(payload.target_duration_seconds);
  if (!targetDurationSeconds || targetDurationSeconds <= 0) {
    return;
  }

  writeGeneratedVideoTaskContext(taskId, {
    task_id: taskId,
    status: "pending",
    auto_trim_review: true,
    slot_id: payload.slot_id,
    slot_type: payload.slot_type,
    slot_description: payload.slot_description,
    target_duration_seconds: targetDurationSeconds,
    generation_prompt: payload.video_prompt,
    approved_image_uri: payload.approved_image_uri,
    source_image_uri: requestPayload.image_uri,
    source_frame: requestPayload.source_frame,
    generation_mode: payload.generation_mode || requestPayload.generation_mode,
    requested_video_duration_seconds: requestPayload.duration_seconds,
    allow_fallback: payload.allow_fallback !== false,
    created_at: new Date().toISOString()
  });
};

const attachAutoTrimResultToVideoTask = (
  taskResult: JsonObject,
  trimResult: JsonObject
): JsonObject => {
  const content = asJsonObject(taskResult.content);
  const trimmedVideoPath = normalizeOptionalString(trimResult.trimmed_video_path);
  const trimmedVideoUrl = getGeneratedVideoPublicUrl(trimmedVideoPath);
  const originalVideoUrl = getVideoUrlFromTaskResult(taskResult);

  return {
    ...taskResult,
    content: {
      ...content,
      original_video_url: originalVideoUrl,
      final_video_url: trimmedVideoUrl || trimmedVideoPath || originalVideoUrl,
      final_video_path: trimmedVideoPath,
      trimmed_video_path: trimmedVideoPath,
      trimmed_video_url: trimmedVideoUrl,
      trim_recommendation: trimResult.trim_recommendation
    },
    postprocess: {
      auto_trim_review: "succeeded",
      trim_result: trimResult
    }
  };
};

const maybeAutoTrimCompletedVideoTask = async (
  taskId: string,
  taskResult: JsonObject
): Promise<JsonObject> => {
  const context = readGeneratedVideoTaskContext(taskId);
  if (!context) {
    return taskResult;
  }

  const savedTrimResult = asJsonObject(context.trim_result);
  if (Object.keys(savedTrimResult).length > 0) {
    return attachAutoTrimResultToVideoTask(taskResult, savedTrimResult);
  }

  const status = normalizeOptionalString(taskResult.status)?.toLowerCase();
  if (status !== "succeeded") {
    return {
      ...taskResult,
      postprocess: {
        auto_trim_review: "pending",
        target_duration_seconds: context.target_duration_seconds
      }
    };
  }

  const videoUri = getVideoUrlFromTaskResult(taskResult);
  if (!videoUri) {
    return {
      ...taskResult,
      postprocess: {
        auto_trim_review: "failed",
        reason: "provider task succeeded but video_url is missing"
      }
    };
  }

  const trimResult = await reviewAndTrimV2GeneratedVideo({
    video_uri: videoUri,
    slot_id: normalizeOptionalString(context.slot_id),
    slot_type: normalizeOptionalString(context.slot_type),
    target_duration_seconds: Number(context.target_duration_seconds),
    generation_prompt: normalizeOptionalString(context.generation_prompt),
    slot_description: normalizeOptionalString(context.slot_description),
    trim_video: true,
    allow_fallback: context.allow_fallback !== false
  });
  const nextContext = {
    ...context,
    status: "succeeded",
    trim_result: trimResult,
    updated_at: new Date().toISOString()
  };
  writeGeneratedVideoTaskContext(taskId, nextContext);

  return attachAutoTrimResultToVideoTask(taskResult, trimResult);
};

export const reviewAndTrimV2GeneratedVideo = async (
  payload: V2GeneratedVideoTrimReviewRequest
): Promise<JsonObject> => {
  const videoUri = normalizeOptionalString(payload.video_uri);
  if (!videoUri) {
    throw new V2PipelineInputError("video_uri is required");
  }

  const targetDurationSeconds = Number(payload.target_duration_seconds);
  if (!Number.isFinite(targetDurationSeconds) || targetDurationSeconds <= 0) {
    throw new V2PipelineInputError("target_duration_seconds must be greater than 0");
  }

  const allowFallback = payload.allow_fallback !== false;
  const localVideoPath = await materializeGeneratedVideo(videoUri);
  const videoDurationSeconds = await getGeneratedVideoDurationSeconds(localVideoPath);
  const slotType = normalizeSlotType(payload.slot_type) || "generated_video_slot";
  const slotId = normalizeOptionalString(payload.slot_id) || slotType;
  const analysisPayload = {
    video: {
      uri: localVideoPath,
      source_uri: isHttpUrl(videoUri) ? videoUri : undefined
    },
    slot_id: slotId,
    slot_type: slotType,
    target_duration_seconds: targetDurationSeconds,
    source_video_duration_seconds: videoDurationSeconds,
    generation_prompt: payload.generation_prompt,
    slot_description: payload.slot_description,
    instruction:
      "阅读这段图生视频，判断它是否适合对应广告槽位，并从中挑选最适合剪进成片的一段。必须返回 JSON：recommended_start_seconds、recommended_end_seconds、recommended_duration_seconds、quality_status、confidence、reason、visual_summary、editing_notes。起止时间必须在视频真实时长内，推荐片段应优先覆盖产品/卖点动作最清楚、画面最稳定、最适合该槽位的一段。"
  };

  let rawAnalysis: JsonObject;
  try {
    rawAnalysis = await requestMultimodalJson(
      "review_generated_video_for_trim",
      v2SystemPrompt,
      analysisPayload
    );
  } catch (error) {
    if (!allowFallback) {
      throw error;
    }

    rawAnalysis = makeFallbackGeneratedVideoTrimAnalysis(
      targetDurationSeconds,
      videoDurationSeconds,
      sanitizeFallbackReason(error)
    );
  }

  const trimRecommendation = normalizeTrimRecommendation(
    rawAnalysis,
    targetDurationSeconds,
    videoDurationSeconds
  );
  const shouldTrim = payload.trim_video === true;
  const trimmedVideoPath = shouldTrim
    ? await trimGeneratedVideo(
        localVideoPath,
        Number(trimRecommendation.recommended_start_seconds),
        Number(trimRecommendation.recommended_duration_seconds)
      )
    : undefined;

  return {
    slot_id: slotId,
    slot_type: slotType,
    video_uri: videoUri,
    local_video_path: localVideoPath,
    trim_recommendation: trimRecommendation,
    trimmed_video_path: trimmedVideoPath,
    trim_video_requested: shouldTrim
  };
};

const parseAssemblyResolution = (
  value: unknown
): { width: number; height: number; label: string } => {
  const resolution = normalizeOptionalString(value) || "720x1280";
  const match = resolution.match(/^(\d{3,4})x(\d{3,4})$/u);

  if (!match) {
    throw new V2PipelineInputError("resolution must use WIDTHxHEIGHT format");
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 360 ||
    height < 360 ||
    width > 3840 ||
    height > 3840
  ) {
    throw new V2PipelineInputError("resolution is outside supported bounds");
  }

  return {
    width,
    height,
    label: `${width}x${height}`
  };
};

const normalizeAssemblyFps = (value: unknown): number => {
  const fps = Number(value || 24);
  if (!Number.isFinite(fps) || fps < 1 || fps > 60) {
    throw new V2PipelineInputError("fps must be between 1 and 60");
  }

  return Number(fps.toFixed(3));
};

const normalizeAssemblyBackgroundColor = (value: unknown): string => {
  const backgroundColor = normalizeOptionalString(value) || "black";
  if (!/^(?:#[0-9a-f]{6}|[a-z]+)$/iu.test(backgroundColor)) {
    throw new V2PipelineInputError("background_color must be a color name or #RRGGBB");
  }

  return backgroundColor;
};

const escapeConcatPath = (filePath: string): string =>
  filePath.replace(/'/gu, "'\\''");

export const assembleV2FinalVideo = async (
  payload: V2FinalAssemblyRequest
): Promise<JsonObject> => {
  if (!Array.isArray(payload.slots) || payload.slots.length === 0) {
    throw new V2PipelineInputError("slots is required");
  }

  const resolution = parseAssemblyResolution(payload.resolution);
  const fps = normalizeAssemblyFps(payload.fps);
  const backgroundColor = normalizeAssemblyBackgroundColor(payload.background_color);
  const allowLoopShortClips = payload.allow_loop_short_clips !== false;
  const normalizedSlots = payload.slots.map((slot, index) => {
    const videoUri = normalizeOptionalString(slot.video_uri);
    const durationSeconds = Number(slot.duration_seconds);
    const startSeconds = Number(slot.start_seconds || 0);

    if (!videoUri) {
      throw new V2PipelineInputError(`slots[${index}].video_uri is required`);
    }

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new V2PipelineInputError(
        `slots[${index}].duration_seconds must be greater than 0`
      );
    }

    if (!Number.isFinite(startSeconds) || startSeconds < 0) {
      throw new V2PipelineInputError(
        `slots[${index}].start_seconds must be greater than or equal to 0`
      );
    }

    return {
      slot_id:
        normalizeOptionalString(slot.slot_id) ||
        `slot_${String(index + 1).padStart(2, "0")}`,
      slot_type: normalizeSlotType(slot.slot_type) || "unknown",
      video_uri: videoUri,
      duration_seconds: Number(durationSeconds.toFixed(3)),
      start_seconds: Number(startSeconds.toFixed(3))
    };
  });

  const totalDurationSeconds = Number(
    normalizedSlots
      .reduce((total, slot) => total + slot.duration_seconds, 0)
      .toFixed(3)
  );
  const targetDurationSeconds = normalizeNumberField(payload.target_duration_seconds);
  if (
    targetDurationSeconds !== undefined &&
    Math.abs(totalDurationSeconds - targetDurationSeconds) > 0.05
  ) {
    throw new V2PipelineInputError(
      `slot durations ${totalDurationSeconds}s do not match target_duration_seconds ${targetDurationSeconds}s`
    );
  }

  ensureFinalAssemblyDir();
  const assemblyId = crypto.randomUUID();
  const workDir = path.join(finalAssemblyDir, `work_${assemblyId}`);
  fs.mkdirSync(workDir, { recursive: true });

  const segmentFiles: string[] = [];
  const segmentResults: JsonObject[] = [];
  const videoFilter = [
    `scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=decrease`,
    `pad=${resolution.width}:${resolution.height}:(ow-iw)/2:(oh-ih)/2:${backgroundColor}`,
    "setsar=1",
    `fps=${fps}`,
    "format=yuv420p"
  ].join(",");

  for (const [index, slot] of normalizedSlots.entries()) {
    const sourceVideoPath = await materializeAssemblyVideo(slot.video_uri, workDir, index);
    const segmentPath = path.join(
      workDir,
      `segment_${String(index + 1).padStart(2, "0")}.mp4`
    );
    const ffmpegArgs = [
      "-y",
      ...(allowLoopShortClips ? ["-stream_loop", "-1"] : []),
      "-i",
      sourceVideoPath,
      "-ss",
      String(slot.start_seconds),
      "-t",
      String(slot.duration_seconds),
      "-vf",
      videoFilter,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-r",
      String(fps),
      segmentPath
    ];

    await runFFmpeg(ffmpegArgs, [
      { path: sourceVideoPath, replacement: "[source video]" },
      { path: segmentPath, replacement: "[assembly segment]" }
    ]);

    segmentFiles.push(segmentPath);
    segmentResults.push({
      ...slot,
      source_video_path: sourceVideoPath,
      normalized_segment_path: segmentPath
    });
  }

  const concatListPath = path.join(workDir, "concat.txt");
  fs.writeFileSync(
    concatListPath,
    segmentFiles.map((filePath) => `file '${escapeConcatPath(filePath)}'`).join("\n")
  );

  const finalVideoPath = path.join(finalAssemblyDir, `final_video_${assemblyId}.mp4`);
  await runFFmpeg(
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      finalVideoPath
    ],
    [
      { path: concatListPath, replacement: "[concat list]" },
      { path: finalVideoPath, replacement: "[final video]" }
    ]
  );

  const finalDurationSeconds = await getGeneratedVideoDurationSeconds(finalVideoPath);

  return {
    assembly_id: assemblyId,
    final_video_url: getFinalAssemblyPublicUrl(finalVideoPath),
    final_video_path: finalVideoPath,
    target_duration_seconds: targetDurationSeconds,
    planned_duration_seconds: totalDurationSeconds,
    final_duration_seconds: finalDurationSeconds,
    resolution: resolution.label,
    fps,
    audio_policy: {
      source_clip_audio: "muted",
      per_clip_bgm: "disabled",
      final_bgm: {
        selection_mode: "ai_selected_at_final_assembly",
        status: "pending_provider_integration"
      }
    },
    slots: segmentResults
  };
};

export const getV2VideoGenerationTask = async (
  taskId: string
): Promise<JsonObject> => {
  const normalizedTaskId = normalizeOptionalString(taskId);

  if (!normalizedTaskId) {
    throw new V2PipelineInputError("task_id is required");
  }

  const taskResult = await requestVideoGenerationTask(normalizedTaskId);
  return maybeAutoTrimCompletedVideoTask(normalizedTaskId, taskResult);
};
