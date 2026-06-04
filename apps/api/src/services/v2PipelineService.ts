import { config } from "../config/index.js";
import {
  requestImageCandidates,
  requestImageToVideo,
  requestMultimodalJson
} from "../v2/providers/apiJsonClient.js";
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
  "You are the API-first V2 planning engine for a short-video structure transfer product.",
  "Always return one valid JSON object. Do not include markdown.",
  "The vertical is commercial advertising short videos, usually around 30 seconds.",
  "Commercial ad structures usually include: strong hook, pain point or demand scene, product hero reveal, selling-point proof, usage process, effect comparison, and CTA.",
  "Do not copy reference videos literally. Extract reusable structure, rhythm, visual logic, commercial persuasion logic, and packaging logic.",
  "When material is missing, produce generation prompts for new user content rather than copying the sample.",
  "If user materials are sufficient, produce an assembly/editing plan. If materials are insufficient, produce image prompts first and then image-to-video prompts.",
  "The product flow is: read 2-3 reference videos, analyze user request/materials, synthesize a fillable architecture, then plan assembly or AIGC prompts."
].join(" ");

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
      "Fallback analysis assumes this reference is a short commercial ad and extracts reusable advertising structure rather than literal content.",
    target_duration_seconds: targetDuration,
    structure_slots: commercialAdSlots.map((slot, slotIndex) => ({
      slot_id: `ref_${index}_slot_${String(slotIndex + 1).padStart(2, "0")}`,
      slot_type: slot.slot_type,
      time_range: makeSlotDuration(slotIndex, targetDuration),
      role: slot.role,
      reusable_rule: `Use ${slot.slot_type} to serve this commercial objective: ${slot.role}.`,
      common_visuals: slot.common_visuals,
      common_packaging: slot.common_packaging
    })),
    rhythm_patterns: [
      "0-3s strong hook",
      "3-11s pain point and product reveal",
      "11-22s selling proof and usage process",
      "22-30s comparison and CTA"
    ],
    visual_language: [
      "vertical 9:16 commercial framing",
      "large readable text overlays",
      "fast cuts around hook and CTA",
      "close-up product proof shots"
    ],
    transferable_rules: [
      "Extract persuasive slot order, not specific sample content.",
      "Prioritize product visibility and proof.",
      "Use packaging to compensate when raw footage is weak."
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
      "Fallback 未真实观看素材内容，只基于输入引用和文本做结构判断。",
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
        editing_instruction: `Use this segment for ${slot.role}.`
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
          prompt: `生成一张竖屏商业广告开头图，主题是“${goal}”，面向“${audience}”，画面要有强冲突或需求痛点，突出${productName}可解决问题；不要复刻任何样例视频画面。`
        },
        {
          prompt_ref: "product_hero_image",
          slot_type: "product_hero",
          prompt: `生成一张竖屏商品主视觉图，突出${productName}，干净商业广告构图，适合 30 秒短视频中段产品亮相；不要出现样例视频中的具体人物或场景。`
        },
        {
          prompt_ref: "comparison_image",
          slot_type: "effect_comparison",
          prompt: `生成一张竖屏前后对比广告图，表达${productName}带来的改善或结果证明，适合商业广告的对比段落。`
        }
      ],
      video_prompt_candidates: [
        {
          prompt_ref: "hook_image_to_video",
          input_image_ref: "hook_image",
          prompt: `把确认后的开头图生成 3 秒竖屏短视频镜头，轻微推进、快速信息出现，服务于“${goal}”的强 Hook。`
        },
        {
          prompt_ref: "product_hero_image_to_video",
          input_image_ref: "product_hero_image",
          prompt: `把确认后的产品主视觉图生成 4 秒竖屏商品展示镜头，镜头平稳、突出包装和核心卖点。`
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
      reason: "image generation provider unavailable"
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
        note: "Mock candidate only. Configure image provider to receive a real image URI."
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
      reason: "video generation provider unavailable"
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
      "This is a mock image-to-video job response. Configure the real video provider adapter before expecting generated media."
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
            "Read and understand this commercial ad reference video. Return architecture slots, rhythm, visual/packaging style, persuasion logic, content logic, and reusable patterns. Do not copy literal content."
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
        "Analyze what the user wants and what their materials can support for a 30-second commercial ad. Return usable assets, weak assets, missing assets, and material-to-slot suggestions."
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
        "Combine multiple commercial ad reference architectures into one fillable 30-second architecture for the user's new ad. Return editable slots the user can fill."
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
      instruction:
        "Decide whether existing user material is enough for a commercial ad. If enough, return an assembly plan. If not, return image prompt candidates first and image-to-video prompts for a video generation model."
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
            return normalizeImageCandidates(
              await requestImageCandidates(getPromptPackage(productionPlan), count),
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
          ? "V2 completed with fallback outputs. Provider-specific API adapters or credentials should be verified before treating generated media as real."
          : "V2 API-first pipeline completed. If image_candidates are present, ask the user to approve one before calling image-to-video generation."
    }
  };
};

export const generateV2ImageCandidates = async (
  payload: V2ImageCandidateRequest
): Promise<JsonObject> => {
  if (!payload.prompt_package || typeof payload.prompt_package !== "object") {
    throw new V2PipelineInputError("prompt_package is required");
  }

  const count = Math.max(1, Math.min(6, Number(payload.count || 3)));
  const allowFallback = payload.allow_fallback !== false;

  try {
    return await requestImageCandidates(payload.prompt_package, count);
  } catch (error) {
    if (!allowFallback) {
      throw error;
    }

    return {
      ...makeFallbackImageCandidateResponse(payload.prompt_package, count),
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
