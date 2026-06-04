import { config } from "../config/index.js";
import {
  requestImageCandidates,
  requestImageToVideo,
  requestMultimodalJson
} from "../v2/providers/apiJsonClient.js";
import { collectV2ReferenceFramesFromVideos } from "../v2/referenceFrames.js";
import type {
  JsonObject,
  V2ImageCandidate,
  V2ImageCandidateRequest,
  V2ImageToVideoRequest,
  V2PipelineRequest,
  V2PipelineResult,
  V2TextAsset,
  V2UserRequest,
  V2VideoRef
} from "../v2/types.js";

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
  "缺失素材的图片生成 prompt 默认应说明：为同一个槽位生成 3 张候选图，供用户选择。3 张图应保持同一广告意图和产品设定，但在构图、光线、景别或背景细节上有差异。",
  "图片生成 prompt 不允许把 3 张候选图设计成 3 个不同主题、不同物体或不同场景；只能围绕一个具体缺失槽位和一个具体视觉主题做三种变体。",
  "图片生成 prompt 如果需要举例，最多只能给一个主示例；不要写“例如 1/2/3”这类会导致模型分别生成不同主题的枚举。",
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
    "图片生成 prompt 默认要求生成 3 张候选图供用户选择，并说明三张图之间应在构图、光线、景别或背景细节上形成差异。",
    "3 张候选图必须是同一主题下的三种变体，不允许分别生成 3 个不同物体、不同场景或不同广告方向。",
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
    product_name: normalizeOptionalString(record.product_name ?? record.productName),
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
        Math.min(6, Number(payload.options?.image_candidate_count || 3))
      ),
      generate_image_candidates:
        payload.options?.generate_image_candidates === true,
      target_duration_seconds: Math.max(
        15,
        Math.min(60, Number(payload.options?.target_duration_seconds || 30))
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
        : "用户素材不足，建议先生成图片候选，再图生视频补齐缺口。"
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
      editable_fields: ["visual", "subtitle", "voiceover", "packaging", "material_ref"]
    })),
    material_fit: asJsonObject(userMaterialAnalysis).coverage_by_slot_type || [],
    decision_points: [
      "如果 product_hero / usage_process 素材足够，优先拼接真实素材。",
      "如果 hook / comparison / CTA 缺素材，优先生成图片候选供用户确认。",
      "图片确认后再图生视频，降低直接生成视频的黑盒风险。"
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
        : "素材不足，优先生成关键画面候选，用户确认后再图生视频。",
      timeline_outline: commercialAdSlots.map((slot, index) => ({
        item_id: `outline_${String(index + 1).padStart(2, "0")}`,
        slot_type: slot.slot_type,
        time_range: makeSlotDuration(index, targetDuration),
        visual_source:
          canAssemble || index < normalized.user_materials.length
            ? "user_material"
            : "generated_image_then_video",
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
            "【候选图要求】请为该槽位生成 3 张候选图供用户选择，三张图必须围绕同一个具体痛点主题和同一产品设定，只在构图、光线、景别或背景细节上有差异。",
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
            "【候选图要求】请为该槽位生成 3 张候选图供用户选择，三张图必须保持同一产品、同一包装和同一广告意图，只在产品角度、光线、背景和景别上有差异。",
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
            "【候选图要求】请为该槽位生成 3 张候选图供用户选择，三张图必须保持同一对比逻辑、同一主体和同一产品设定，只在分屏形式、构图和光线氛围上有差异。",
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
      "先生成图片候选并由用户确认，再进入图生视频。"
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
  payload: V2ImageToVideoRequest
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
      image_uri: payload.approved_image_uri,
      prompt: payload.video_prompt,
      duration_seconds: payload.duration_seconds || 5,
      aspect_ratio: payload.aspect_ratio || "9:16"
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
          expected_slots: commercialAdSlots.map((slot) => slot.slot_type),
          instruction:
            "阅读并理解这个商业广告样例视频。请用中文返回广告结构槽位、节奏、视觉/包装风格、说服逻辑、内容逻辑和可迁移模式。不要复制样例视频的具体内容。所有图片生成 prompt 和图生视频 prompt 必须中文。"
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
      expected_slots: commercialAdSlots.map((slot) => slot.slot_type),
      user_request: normalized.user_request,
      user_materials: normalized.user_materials,
      text_assets: normalized.text_assets,
      instruction:
        "分析用户想要什么，以及用户素材能支撑一个商业广告短视频中的哪些槽位。请用中文返回可用素材、弱素材、缺失素材、素材到槽位的建议。所有说明和后续 prompt 必须中文。"
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
      expected_slots: commercialAdSlots.map((slot) => slot.slot_type),
      user_request: normalized.user_request,
      reference_video_analyses: referenceVideoAnalyses,
      user_material_analysis: userMaterialAnalysis,
      instruction:
        "综合多个商业广告样例的结构，生成一个适合用户新广告的可填写结构。请用中文返回每个可编辑槽位、时长、画面方向、字幕/口播方向、包装建议、需要用户填入或补充的内容。所有生成 prompt 必须中文。"
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

  const productionPlanResult = await callMultimodalWithFallback(
    "plan_assembly_or_generation",
    {
      vertical: "commercial_advertising",
      target_duration_seconds: targetDuration,
      user_request: normalized.user_request,
      fillable_architecture: fillableArchitecture,
      user_material_analysis: userMaterialAnalysis,
      detailed_generation_prompt_requirements: detailedGenerationPromptRequirements,
      instruction:
        "判断现有用户素材是否足够生成商业广告。如果足够，请用中文返回剪辑/拼接方案；如果不足，请先用中文返回缺失素材的图片生成 prompt，再用中文返回图生视频 prompt。所有 prompt 必须描述新商品和新场景，不要复制样例视频内容。所有图片生成 prompt 和图生视频 prompt 必须按 detailed_generation_prompt_requirements 中的章节组织，内容要像专业视频提示词一样详细。图片生成 prompt 要明确说明为同一槽位生成 3 张候选图供用户选择，且 3 张图必须是同一个具体主题、同一产品设定、同一场景逻辑下的三种变体，只能在构图、光线、景别、镜头角度或背景细节上有差异。不要用“例如 1/2/3”列出多个互斥主体或场景，避免模型把三张候选图生成成三个不同主题。特别注意产品和人物规则：如果用户素材里已有产品、包装、品牌视觉或主角人物，后续生成必须尽量还原它们，不能写“不要出现完整产品”“不要出现人物”等与用户素材冲突的负面约束；这类限制只能表达为“不要出现无关产品/无关人物/无关品牌”。如果用户素材里没有人物且槽位不强制人物出现，则不要凭空生成人物，优先展示产品、道具、场景、手部动作或包装画面；如果必须新增人物，需详细描述符合产品设定和目标人群的人物样貌、穿着、状态和动作。"
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
  const productionPlan = productionPlanResult.output;
  if (productionPlanResult.fallbackReason) {
    fallbackReasons.push(productionPlanResult.fallbackReason);
  }

  const imageCandidates =
    normalized.options.generate_image_candidates === true
      ? await (async () => {
          const count = Number(normalized.options.image_candidate_count || 3);
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
          : "V2 API-first 链路已完成。如果返回 image_candidates，请先让用户确认候选图，再调用图生视频。"
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

  const count = Math.max(1, Math.min(6, Number(payload.count || 3)));
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

export const generateV2ImageToVideo = async (
  payload: V2ImageToVideoRequest
): Promise<JsonObject> => {
  if (!payload.approved_image_uri) {
    throw new V2PipelineInputError("approved_image_uri is required");
  }

  if (!payload.video_prompt) {
    throw new V2PipelineInputError("video_prompt is required");
  }

  const requestPayload = {
    image_uri: payload.approved_image_uri,
    prompt: payload.video_prompt,
    duration_seconds: payload.duration_seconds || 5,
    aspect_ratio: payload.aspect_ratio || "9:16"
  };
  const allowFallback = payload.allow_fallback !== false;

  try {
    return await requestImageToVideo(requestPayload);
  } catch (error) {
    if (!allowFallback) {
      throw error;
    }

    return {
      ...makeFallbackImageToVideoResponse(payload),
      fallback_reason: sanitizeFallbackReason(error)
    };
  }
};
