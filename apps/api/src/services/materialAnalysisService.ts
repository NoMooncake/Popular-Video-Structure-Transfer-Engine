import {
  createMaterialInput,
  type CreateMaterialInputPayload,
  type MaterialInput,
  MaterialInputValidationError
} from "./materialInputService.js";
import { assertValidSchema } from "../utils/schemaValidator.js";

type MaterialType = "video" | "image" | "text" | "copy" | "audio" | "other";

type Material = {
  material_id: string;
  type: MaterialType;
  asset_role: "user_uploaded" | "text_asset" | "derived_segment" | "mock_asset";
  uri?: string;
  file_id?: string;
  description: string;
  tags: string[];
  content_roles: string[];
  candidate_slot_types: string[];
  metadata: Record<string, unknown>;
};

type MaterialSegment = {
  segment_id: string;
  material_ref: string;
  time_range?: string;
  content: string;
  tags: string[];
  recommended_slot: string;
  recommended_slot_types: string[];
  quality_score: number;
  fit_score: number;
  usable: boolean;
  match_reasons: string[];
  limitations: string[];
  missing_risks: string[];
};

export type MaterialAnalysis = {
  id: string;
  version: string;
  created_at: string;
  source: {
    type: "manual";
    material_input_ref: string;
    model: "rule_based_material_analyzer_v0.1";
  };
  target_content_ref: string;
  materials: Material[];
  segments: MaterialSegment[];
  coverage_summary: {
    supported_slot_types: string[];
    weak_slot_types: string[];
    unsupported_slot_types: string[];
    material_gaps: Array<{
      slot_type: string;
      reason: string;
      severity: "low" | "medium" | "high";
      suggested_strategy: string;
    }>;
    notes: string;
  };
};

export class MaterialAnalysisInputError extends Error {
  statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "MaterialAnalysisInputError";
  }
}

type MaterialAnalysisRequest = {
  material_input?: unknown;
  materialInput?: unknown;
} & CreateMaterialInputPayload;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isMaterialInput = (value: unknown): value is MaterialInput => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    isRecord(value.target) &&
    typeof value.target.target_topic === "string" &&
    Array.isArray(value.selling_points) &&
    Array.isArray(value.uploaded_files) &&
    Array.isArray(value.text_assets)
  );
};

const getMaterialInput = (payload: MaterialAnalysisRequest): MaterialInput => {
  const providedInput = payload.material_input ?? payload.materialInput;

  if (providedInput !== undefined) {
    if (!isMaterialInput(providedInput)) {
      throw new MaterialAnalysisInputError(
        "material_input must be a valid material input object"
      );
    }

    return providedInput;
  }

  try {
    return createMaterialInput(payload);
  } catch (error) {
    if (error instanceof MaterialInputValidationError) {
      throw new MaterialAnalysisInputError(error.message);
    }

    throw error;
  }
};

const unique = (items: string[]): string[] => {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)));
};

const lowerIncludesAny = (value: string, keywords: string[]): boolean => {
  const normalizedValue = value.toLowerCase();
  return keywords.some((keyword) => normalizedValue.includes(keyword));
};

const inferUploadedMaterialType = (fileRef: MaterialInput["uploaded_files"][number]): MaterialType => {
  const hint = `${fileRef.file_id} ${fileRef.path}`.toLowerCase();

  if (
    lowerIncludesAny(hint, [
      ".jpg",
      ".jpeg",
      ".png",
      ".webp",
      "image",
      "photo",
      "cover"
    ])
  ) {
    return "image";
  }

  if (
    lowerIncludesAny(hint, [
      ".mp4",
      ".mov",
      ".webm",
      "video",
      "clip"
    ])
  ) {
    return "video";
  }

  return "video";
};

const getSlotsForMaterialType = (type: MaterialType): string[] => {
  if (type === "image") {
    return ["product_reveal", "proof_comparison", "decision_warning"];
  }

  if (type === "text" || type === "copy") {
    return ["risk_or_pain_hook", "decision_warning", "cta"];
  }

  if (type === "video") {
    return ["pain_desire", "usage_scene", "product_reveal", "cta"];
  }

  return ["decision_warning"];
};

const getContentRolesForMaterialType = (type: MaterialType): string[] => {
  if (type === "image") {
    return ["product_visual", "proof_visual"];
  }

  if (type === "text" || type === "copy") {
    return ["subtitle_copy", "selling_point_copy", "warning_copy"];
  }

  if (type === "video") {
    return ["usage_scene", "daily_life", "user_material"];
  }

  return ["supporting_material"];
};

const getTagsFromText = (text: string): string[] => {
  const tags: string[] = [];

  if (lowerIncludesAny(text, ["痛点", "风险", "避坑", "踩雷", "后怕", "不能"])) {
    tags.push("pain_point", "risk_warning");
  }

  if (lowerIncludesAny(text, ["对比", "比较", "前后", "before", "after"])) {
    tags.push("comparison");
  }

  if (lowerIncludesAny(text, ["证明", "成分", "数据", "测评", "实测"])) {
    tags.push("proof");
  }

  if (lowerIncludesAny(text, ["购买", "收藏", "评论", "转发", "下单", "试试"])) {
    tags.push("cta");
  }

  if (lowerIncludesAny(text, ["产品", "商品", "工具", "猫粮", "大衣", "靴"])) {
    tags.push("product");
  }

  return unique(tags);
};

const getPreferredTextSlots = (text: string): string[] => {
  const slots: string[] = [];

  if (lowerIncludesAny(text, ["痛点", "风险", "避坑", "踩雷", "后怕", "不能"])) {
    slots.push("risk_or_pain_hook");
  }

  if (lowerIncludesAny(text, ["对比", "比较", "证明", "成分", "数据", "测评"])) {
    slots.push("proof_comparison");
  }

  slots.push("decision_warning", "cta");
  return unique(slots);
};

const createUploadedMaterials = (materialInput: MaterialInput): Material[] => {
  return materialInput.uploaded_files.map((fileRef, index) => {
    const type = inferUploadedMaterialType(fileRef);
    const materialNumber = String(index + 1).padStart(2, "0");

    return {
      material_id: `m_file_${materialNumber}`,
      type,
      asset_role: "user_uploaded",
      uri: fileRef.path,
      file_id: fileRef.file_id,
      description:
        type === "image"
          ? `用户上传图片素材 ${materialNumber}，可用于产品展示或证明画面。`
          : `用户上传视频素材 ${materialNumber}，可用于使用场景、产品展示或结尾 CTA。`,
      tags: unique([type, "user_uploaded", "source_material"]),
      content_roles: getContentRolesForMaterialType(type),
      candidate_slot_types: getSlotsForMaterialType(type),
      metadata: {
        role: fileRef.role
      }
    };
  });
};

const createTextMaterials = (materialInput: MaterialInput): Material[] => {
  const sellingPointCopy = materialInput.selling_points
    .sort((left, right) => left.priority - right.priority)
    .map((point) => point.text)
    .join("；");

  const sellingPointMaterial: Material = {
    material_id: "m_text_selling_points",
    type: "text",
    asset_role: "text_asset",
    description: `卖点文案：${sellingPointCopy}`,
    tags: unique(["text", "selling_points", ...getTagsFromText(sellingPointCopy)]),
    content_roles: getContentRolesForMaterialType("text"),
    candidate_slot_types: getPreferredTextSlots(sellingPointCopy),
    metadata: {
      source: "selling_points",
      point_count: materialInput.selling_points.length,
      language: "zh-CN"
    }
  };

  const textAssetMaterials = materialInput.text_assets.map((asset, index) => {
    const materialNumber = String(index + 1).padStart(2, "0");
    const tags = unique(["text", asset.type, ...getTagsFromText(asset.content)]);

    return {
      material_id: `m_text_asset_${materialNumber}`,
      type: "text" as const,
      asset_role: "text_asset" as const,
      description: asset.content,
      tags,
      content_roles: getContentRolesForMaterialType("text"),
      candidate_slot_types: getPreferredTextSlots(asset.content),
      metadata: {
        source: asset.asset_id,
        type: asset.type,
        language: "zh-CN"
      }
    };
  });

  return [sellingPointMaterial, ...textAssetMaterials];
};

const getRecommendedSlot = (candidateSlots: string[]): string => {
  return (
    candidateSlots.find((slot) => slot === "risk_or_pain_hook") ||
    candidateSlots.find((slot) => slot === "product_reveal") ||
    candidateSlots.find((slot) => slot === "proof_comparison") ||
    candidateSlots[0] ||
    "decision_warning"
  );
};

const getSegmentScores = (material: Material): { quality: number; fit: number } => {
  if (material.type === "text") {
    return { quality: 0.82, fit: 0.86 };
  }

  if (material.type === "image") {
    return { quality: 0.78, fit: 0.8 };
  }

  if (material.type === "video") {
    return { quality: 0.74, fit: 0.76 };
  }

  return { quality: 0.6, fit: 0.62 };
};

const createSegmentForMaterial = (
  material: Material,
  index: number
): MaterialSegment => {
  const segmentNumber = String(index + 1).padStart(2, "0");
  const scores = getSegmentScores(material);
  const recommendedSlot = getRecommendedSlot(material.candidate_slot_types);
  const isText = material.type === "text" || material.type === "copy";

  return {
    segment_id: `seg_${segmentNumber}`,
    material_ref: material.material_id,
    content: material.description,
    tags: material.tags,
    recommended_slot: recommendedSlot,
    recommended_slot_types: material.candidate_slot_types,
    quality_score: scores.quality,
    fit_score: scores.fit,
    usable: true,
    match_reasons: [
      isText
        ? "文本素材可以直接转成字幕、标题条或卖点卡片。"
        : "用户上传素材可以作为结构槽位的视觉支撑。",
      `候选槽位：${material.candidate_slot_types.join(" / ")}。`
    ],
    limitations: [
      isText
        ? "纯文本需要依赖包装表达，不能单独承担画面信息。"
        : "当前版本只做基础分类，暂未做真实画面内容识别。"
    ],
    missing_risks: [
      isText
        ? "如果缺少对应画面，前 3 秒吸引力可能不足。"
        : "如果样例结构要求强对比或特写，当前素材可能需要补拍或裁切。"
    ]
  };
};

const buildCoverageSummary = (
  materialInput: MaterialInput,
  materials: Material[],
  segments: MaterialSegment[]
): MaterialAnalysis["coverage_summary"] => {
  const supportedSlotTypes = unique(
    segments.flatMap((segment) => segment.recommended_slot_types)
  );
  const hasVisualMaterial = materials.some(
    (material) => material.type === "video" || material.type === "image"
  );
  const hasImageMaterial = materials.some((material) => material.type === "image");
  const hasMultipleVisuals =
    materials.filter((material) => material.type === "video" || material.type === "image")
      .length >= 2;

  const weakSlotTypes: string[] = [];
  const unsupportedSlotTypes: string[] = [];
  const materialGaps: MaterialAnalysis["coverage_summary"]["material_gaps"] = [];

  if (!hasVisualMaterial) {
    weakSlotTypes.push("product_reveal", "proof_comparison");
    materialGaps.push({
      slot_type: "product_reveal",
      reason: "当前只有文字素材，缺少可直接展示商品或使用场景的画面。",
      severity: "high",
      suggested_strategy: "先用卖点卡片和标题条补齐表达，后续补充图片或视频素材。"
    });
  }

  if (!hasImageMaterial) {
    weakSlotTypes.push("product_closeup");
    unsupportedSlotTypes.push("product_closeup");
    materialGaps.push({
      slot_type: "product_closeup",
      reason: "当前缺少图片或明确特写素材，难以支撑产品细节展示。",
      severity: "medium",
      suggested_strategy: "从视频中截帧、局部放大，或补充产品图片。"
    });
  }

  if (!hasMultipleVisuals) {
    weakSlotTypes.push("proof_comparison");
    materialGaps.push({
      slot_type: "proof_comparison",
      reason: "可对比的视觉素材不足，证明段落可能只能依赖文字说明。",
      severity: "medium",
      suggested_strategy: "使用成分/参数卡片、标题条或补充对比素材。"
    });
  }

  if (!supportedSlotTypes.includes("risk_or_pain_hook")) {
    weakSlotTypes.push("risk_or_pain_hook");
  }

  const notes =
    materialGaps.length > 0
      ? "素材可支撑基础迁移，但部分槽位需要包装补全或后续素材补充。"
      : "素材覆盖较完整，可直接进入槽位匹配和 timeline 生成。";

  return {
    supported_slot_types: supportedSlotTypes,
    weak_slot_types: unique(weakSlotTypes),
    unsupported_slot_types: unique(unsupportedSlotTypes),
    material_gaps: materialGaps,
    notes: `${notes} 目标主题：${materialInput.target.target_topic}。`
  };
};

export const analyzeMaterialInput = (
  payload: MaterialAnalysisRequest
): MaterialAnalysis => {
  const materialInput = getMaterialInput(payload);
  const materials = [
    ...createUploadedMaterials(materialInput),
    ...createTextMaterials(materialInput)
  ];
  const segments = materials.map(createSegmentForMaterial);

  const analysis: MaterialAnalysis = {
    id: `material_analysis_${materialInput.id}`,
    version: "0.1.0",
    created_at: new Date().toISOString(),
    source: {
      type: "manual",
      material_input_ref: materialInput.id,
      model: "rule_based_material_analyzer_v0.1"
    },
    target_content_ref: materialInput.id,
    materials,
    segments,
    coverage_summary: buildCoverageSummary(materialInput, materials, segments)
  };

  assertValidSchema("material_analysis", analysis);
  return analysis;
};
