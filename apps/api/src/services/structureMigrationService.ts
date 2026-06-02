import { validateSchema, assertValidSchema } from "../utils/schemaValidator.js";

type TimeRange = string | Record<string, unknown>;

type StructureSlot = {
  slot_id: string;
  slot_type: string;
  time_range: TimeRange;
  content_goal: string;
  required_materials: unknown[];
  packaging_features: unknown[];
  migration_rule: string;
};

type StructureBlueprint = {
  id: string;
  category?: string;
  slots: StructureSlot[];
};

type Material = {
  material_id: string;
  type: string;
  description: string;
  tags?: string[];
  content_roles?: string[];
  candidate_slot_types?: string[];
};

type MaterialSegment = {
  segment_id: string;
  material_ref: string;
  content: string;
  tags: string[];
  recommended_slot: string;
  recommended_slot_types?: string[];
  fit_score?: number;
  quality_score?: number;
  usable?: boolean;
  match_reasons?: string[];
  limitations?: string[];
};

type MaterialAnalysis = {
  id: string;
  materials: Material[];
  segments: MaterialSegment[];
};

type MigrationTarget = {
  target_topic?: string;
  selling_points?: string[];
};

type SlotMappingItem = {
  slot_id: string;
  slot_type: string;
  time_range: TimeRange;
  original_content_goal: string;
  adapted_content_goal: string;
  required_materials: string[];
  matched_material_refs: string[];
  matched_segment_refs: string[];
  match_confidence: number;
  material_status: "matched" | "partial" | "missing";
  missing_material: boolean;
  missing_reasons: string[];
  suggested_copy: string;
  packaging_suggestions: string[];
  migration_notes: string[];
};

export type SlotMapping = {
  id: string;
  version: string;
  created_at: string;
  source: {
    type: "rule";
    structure_blueprint_ref: string;
    material_analysis_ref: string;
    model: "rule_based_slot_mapper_v0.1";
  };
  target: {
    target_topic?: string;
    selling_points: string[];
  };
  mappings: SlotMappingItem[];
  summary: {
    total_slots: number;
    matched_slots: number;
    partial_slots: number;
    missing_slots: number;
    ready_for_gap_detection: boolean;
    ready_for_timeline: boolean;
    notes: string;
  };
};

type StructureMigrationRequest = {
  structure_blueprint?: unknown;
  structureBlueprint?: unknown;
  material_analysis?: unknown;
  materialAnalysis?: unknown;
  target_topic?: unknown;
  targetTopic?: unknown;
  selling_points?: unknown;
  sellingPoints?: unknown;
};

type CandidateMatch = {
  segment: MaterialSegment;
  material?: Material;
  score: number;
  reasons: string[];
};

export class StructureMigrationInputError extends Error {
  statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "StructureMigrationInputError";
  }
}

const unique = (items: string[]): string[] => {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)));
};

const clamp = (value: number): number => {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
};

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeOptionalString(item))
      .filter((item): item is string => Boolean(item));
  }

  const singleValue = normalizeOptionalString(value);
  return singleValue ? [singleValue] : [];
};

const getValidatedStructureBlueprint = (
  value: unknown
): StructureBlueprint => {
  if (!value) {
    throw new StructureMigrationInputError("structure_blueprint is required");
  }

  const validationResult = validateSchema("structure_blueprint", value);
  if (!validationResult.valid) {
    throw new StructureMigrationInputError(
      `structure_blueprint is invalid: ${JSON.stringify(validationResult.errors)}`
    );
  }

  return value as StructureBlueprint;
};

const getValidatedMaterialAnalysis = (value: unknown): MaterialAnalysis => {
  if (!value) {
    throw new StructureMigrationInputError("material_analysis is required");
  }

  const validationResult = validateSchema("material_analysis", value);
  if (!validationResult.valid) {
    throw new StructureMigrationInputError(
      `material_analysis is invalid: ${JSON.stringify(validationResult.errors)}`
    );
  }

  return value as MaterialAnalysis;
};

const stringifyRequirement = (requirement: unknown): string => {
  if (typeof requirement === "string") {
    return requirement;
  }

  if (typeof requirement === "object" && requirement !== null) {
    const record = requirement as Record<string, unknown>;
    return [record.type, record.description, record.priority]
      .filter((item): item is string => typeof item === "string")
      .join(" ");
  }

  return "";
};

const stringifyPackagingFeature = (feature: unknown): string => {
  if (typeof feature === "string") {
    return feature;
  }

  if (typeof feature === "object" && feature !== null) {
    const record = feature as Record<string, unknown>;
    return [record.type, record.description, record.style]
      .filter((item): item is string => typeof item === "string")
      .join(" ");
  }

  return "";
};

const getSlotAliases = (slotType: string): string[] => {
  const aliasesBySlotType: Record<string, string[]> = {
    risk_or_pain_hook: ["risk_or_pain_hook", "pain_desire", "decision_warning"],
    pain_desire: ["pain_desire", "risk_or_pain_hook", "usage_scene"],
    product_reveal: ["product_reveal", "usage_scene", "decision_warning"],
    proof_comparison: ["proof_comparison", "decision_warning"],
    decision_warning: ["decision_warning", "risk_or_pain_hook", "cta"],
    cta: ["cta", "pain_desire", "decision_warning"]
  };

  return aliasesBySlotType[slotType] || [slotType];
};

const getRequiredMaterialKeywords = (requiredMaterials: string[]): string[] => {
  const keywords: string[] = [];
  const joinedRequirements = requiredMaterials.join(" ").toLowerCase();

  if (
    joinedRequirements.includes("product") ||
    joinedRequirements.includes("商品") ||
    joinedRequirements.includes("产品") ||
    joinedRequirements.includes("包装")
  ) {
    keywords.push("product", "product_reveal", "product_visual");
  }

  if (
    joinedRequirements.includes("copy") ||
    joinedRequirements.includes("标题") ||
    joinedRequirements.includes("文案") ||
    joinedRequirements.includes("warning")
  ) {
    keywords.push("text", "copy", "subtitle_copy", "warning_copy");
  }

  if (
    joinedRequirements.includes("comparison") ||
    joinedRequirements.includes("对比") ||
    joinedRequirements.includes("证明") ||
    joinedRequirements.includes("成分")
  ) {
    keywords.push("comparison", "proof", "proof_comparison");
  }

  if (
    joinedRequirements.includes("visual") ||
    joinedRequirements.includes("画面") ||
    joinedRequirements.includes("镜头")
  ) {
    keywords.push("video", "image", "source_material", "user_uploaded");
  }

  return unique(keywords);
};

const getCandidateText = (
  segment: MaterialSegment,
  material?: Material
): string => {
  return [
    segment.content,
    segment.recommended_slot,
    ...(segment.recommended_slot_types || []),
    ...(segment.tags || []),
    ...(segment.match_reasons || []),
    material?.type,
    material?.description,
    ...(material?.tags || []),
    ...(material?.content_roles || []),
    ...(material?.candidate_slot_types || [])
  ]
    .filter((item): item is string => typeof item === "string")
    .join(" ")
    .toLowerCase();
};

const scoreCandidate = (
  slot: StructureSlot,
  requiredMaterials: string[],
  segment: MaterialSegment,
  material?: Material
): CandidateMatch => {
  const aliases = getSlotAliases(slot.slot_type);
  const recommendedSlots = [
    segment.recommended_slot,
    ...(segment.recommended_slot_types || []),
    ...(material?.candidate_slot_types || [])
  ];
  const candidateText = getCandidateText(segment, material);
  const requiredKeywords = getRequiredMaterialKeywords(requiredMaterials);
  const reasons: string[] = [];
  let score = 0;

  if (recommendedSlots.includes(slot.slot_type)) {
    score += 0.48;
    reasons.push("素材推荐槽位与结构槽位直接匹配。");
  } else if (recommendedSlots.some((slotType) => aliases.includes(slotType))) {
    score += 0.32;
    reasons.push("素材推荐槽位与结构槽位语义相近。");
  }

  const matchedKeywords = requiredKeywords.filter((keyword) =>
    candidateText.includes(keyword.toLowerCase())
  );
  if (matchedKeywords.length > 0) {
    score += Math.min(0.24, matchedKeywords.length * 0.08);
    reasons.push("素材标签/角色命中了槽位所需素材。");
  }

  if (segment.usable !== false) {
    score += 0.08;
  }

  if (typeof segment.fit_score === "number") {
    score += segment.fit_score * 0.12;
  }

  if (typeof segment.quality_score === "number") {
    score += segment.quality_score * 0.08;
  }

  if (reasons.length === 0) {
    reasons.push("素材与槽位只有弱相关，暂不建议直接使用。");
  }

  return {
    segment,
    material,
    score: clamp(score),
    reasons
  };
};

const getMaterialById = (
  materialAnalysis: MaterialAnalysis
): Map<string, Material> => {
  return new Map(
    materialAnalysis.materials.map((material) => [material.material_id, material])
  );
};

const getMatchesForSlot = (
  slot: StructureSlot,
  materialAnalysis: MaterialAnalysis,
  requiredMaterials: string[]
): CandidateMatch[] => {
  const materialById = getMaterialById(materialAnalysis);

  return materialAnalysis.segments
    .map((segment) =>
      scoreCandidate(
        slot,
        requiredMaterials,
        segment,
        materialById.get(segment.material_ref)
      )
    )
    .filter((candidate) => candidate.score >= 0.35)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
};

const getMaterialStatus = (
  matches: CandidateMatch[]
): SlotMappingItem["material_status"] => {
  if (matches.length === 0) {
    return "missing";
  }

  if (matches[0].score >= 0.68) {
    return "matched";
  }

  return "partial";
};

const getSuggestedCopy = (
  slot: StructureSlot,
  target: MigrationTarget
): string => {
  const topic = target.target_topic || "当前主题";
  const primarySellingPoint = target.selling_points?.[0];

  if (slot.slot_type.includes("hook")) {
    return `${topic}，先别急着照抄爆款结构。`;
  }

  if (slot.slot_type.includes("product")) {
    return primarySellingPoint
      ? `${topic}：先突出「${primarySellingPoint}」。`
      : `${topic}：快速展示核心卖点。`;
  }

  if (slot.slot_type.includes("proof") || slot.slot_type.includes("comparison")) {
    return `用对比或证据说明：为什么这个方案适合 ${topic}。`;
  }

  if (slot.slot_type.includes("cta")) {
    return `评论区告诉我你的情况，我帮你判断 ${topic} 怎么选。`;
  }

  return primarySellingPoint
    ? `${topic} 的重点是：${primarySellingPoint}。`
    : slot.content_goal;
};

const getMissingReasons = (
  status: SlotMappingItem["material_status"],
  slot: StructureSlot,
  requiredMaterials: string[]
): string[] => {
  if (status === "matched") {
    return [];
  }

  if (status === "partial") {
    return [
      "已有素材可以部分承接该槽位，但仍需要包装、裁切或文案补全。",
      `该槽位仍需关注：${requiredMaterials.join(" / ") || slot.content_goal}`
    ];
  }

  return [
    "当前素材分析结果中没有找到能直接承接该槽位的素材。",
    `缺少素材类型：${requiredMaterials.join(" / ") || slot.slot_type}`
  ];
};

const buildSlotMappingItem = (
  slot: StructureSlot,
  materialAnalysis: MaterialAnalysis,
  target: MigrationTarget
): SlotMappingItem => {
  const requiredMaterials = slot.required_materials
    .map(stringifyRequirement)
    .filter((item) => item.length > 0);
  const packagingSuggestions = slot.packaging_features
    .map(stringifyPackagingFeature)
    .filter((item) => item.length > 0);
  const matches = getMatchesForSlot(slot, materialAnalysis, requiredMaterials);
  const status = getMaterialStatus(matches);
  const matchConfidence = matches[0]?.score || 0;

  return {
    slot_id: slot.slot_id,
    slot_type: slot.slot_type,
    time_range: slot.time_range,
    original_content_goal: slot.content_goal,
    adapted_content_goal: target.target_topic
      ? `${slot.content_goal} 新主题迁移为：${target.target_topic}。`
      : slot.content_goal,
    required_materials: requiredMaterials,
    matched_material_refs: unique(
      matches
        .map((match) => match.material?.material_id)
        .filter((item): item is string => Boolean(item))
    ),
    matched_segment_refs: unique(matches.map((match) => match.segment.segment_id)),
    match_confidence: matchConfidence,
    material_status: status,
    missing_material: status !== "matched",
    missing_reasons: getMissingReasons(status, slot, requiredMaterials),
    suggested_copy: getSuggestedCopy(slot, target),
    packaging_suggestions: packagingSuggestions,
    migration_notes: unique([
      slot.migration_rule,
      ...matches.flatMap((match) => match.reasons)
    ])
  };
};

const buildSummary = (
  mappings: SlotMappingItem[]
): SlotMapping["summary"] => {
  const matchedSlots = mappings.filter(
    (mapping) => mapping.material_status === "matched"
  ).length;
  const partialSlots = mappings.filter(
    (mapping) => mapping.material_status === "partial"
  ).length;
  const missingSlots = mappings.filter(
    (mapping) => mapping.material_status === "missing"
  ).length;

  return {
    total_slots: mappings.length,
    matched_slots: matchedSlots,
    partial_slots: partialSlots,
    missing_slots: missingSlots,
    ready_for_gap_detection: true,
    ready_for_timeline: mappings.length > 0 && missingSlots < mappings.length,
    notes:
      missingSlots > 0 || partialSlots > 0
        ? "已完成槽位映射，部分槽位需要进入缺口识别和补全策略。"
        : "所有槽位都有可用素材匹配，可进入 timeline generation。"
  };
};

export const migrateStructureToMaterials = (
  payload: StructureMigrationRequest
): SlotMapping => {
  const structureBlueprint = getValidatedStructureBlueprint(
    payload.structure_blueprint ?? payload.structureBlueprint
  );
  const materialAnalysis = getValidatedMaterialAnalysis(
    payload.material_analysis ?? payload.materialAnalysis
  );
  const target: MigrationTarget = {
    target_topic: normalizeOptionalString(
      payload.target_topic ?? payload.targetTopic
    ),
    selling_points: normalizeStringArray(
      payload.selling_points ?? payload.sellingPoints
    )
  };

  const mappings = structureBlueprint.slots.map((slot) =>
    buildSlotMappingItem(slot, materialAnalysis, target)
  );

  const slotMapping: SlotMapping = {
    id: `slot_mapping_${structureBlueprint.id}_${materialAnalysis.id}`,
    version: "0.1.0",
    created_at: new Date().toISOString(),
    source: {
      type: "rule",
      structure_blueprint_ref: structureBlueprint.id,
      material_analysis_ref: materialAnalysis.id,
      model: "rule_based_slot_mapper_v0.1"
    },
    target: {
      target_topic: target.target_topic,
      selling_points: target.selling_points || []
    },
    mappings,
    summary: buildSummary(mappings)
  };

  assertValidSchema("slot_mapping", slotMapping);
  return slotMapping;
};
