import {
  detectGapsFromSlotMapping,
  type GapReport
} from "./gapDetectService.js";
import {
  generateGapFillStrategies,
  type GapFillStrategyReport
} from "./gapFillStrategyService.js";
import {
  analyzeMaterialInput,
  type MaterialAnalysis
} from "./materialAnalysisService.js";
import {
  createMaterialInput,
  type CreateMaterialInputPayload,
  type MaterialInput,
  MaterialInputValidationError
} from "./materialInputService.js";
import {
  analyzeSampleVideo,
  type SampleAnalysis
} from "./sampleAnalyzeService.js";
import {
  extractStructureBlueprint,
  type StructureBlueprint
} from "./structureExtractService.js";
import {
  migrateStructureToMaterials,
  type SlotMapping
} from "./structureMigrationService.js";
import {
  generateTimelinePlan,
  type TimelinePlan
} from "./timelineGenerateService.js";
import { validateSchema } from "../utils/schemaValidator.js";

type PipelineStage =
  | "sample_analyze"
  | "structure_extract"
  | "material_input"
  | "material_analyze"
  | "structure_migrate"
  | "gap_detect"
  | "gap_fill_strategy"
  | "timeline_generate";

type P0PipelineRequest = {
  sample_file_id?: unknown;
  sampleFileId?: unknown;
  sample_analysis?: unknown;
  sampleAnalysis?: unknown;
  material_input?: unknown;
  materialInput?: unknown;
  target_topic?: unknown;
  targetTopic?: unknown;
  target_audience?: unknown;
  targetAudience?: unknown;
  product_name?: unknown;
  productName?: unknown;
  creative_brief?: unknown;
  creativeBrief?: unknown;
  selling_points?: unknown;
  sellingPoints?: unknown;
  uploaded_file_ids?: unknown;
  uploadedFileIds?: unknown;
  text_assets?: unknown;
  textAssets?: unknown;
  vertical?: unknown;
  category?: unknown;
  use_mock?: unknown;
  useMock?: unknown;
  confidence_threshold?: unknown;
  confidenceThreshold?: unknown;
};

type P0PipelineResult = {
  id: string;
  version: string;
  created_at: string;
  source: {
    type: "rule";
    model: "rule_based_p0_pipeline_v0.1";
  };
  input: {
    sample_source: "uploaded_video" | "provided_sample_analysis";
    sample_file_id?: string;
    material_input_ref: string;
  };
  stages: {
    sample_analysis: SampleAnalysis;
    structure_blueprint: StructureBlueprint;
    material_input: MaterialInput;
    material_analysis: MaterialAnalysis;
    slot_mapping: SlotMapping;
    gap_report: GapReport;
    fill_strategies: GapFillStrategyReport;
    timeline_plan: TimelinePlan;
  };
  summary: {
    status: "completed";
    stage_count: number;
    total_slots: number;
    total_gaps: number;
    timeline_duration_seconds: number;
    timeline_item_count: number;
    notes: string;
  };
};

export class P0PipelineInputError extends Error {
  statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "P0PipelineInputError";
  }
}

export class P0PipelineStageError extends Error {
  statusCode: number;
  stage: PipelineStage;
  causeMessage: string;

  constructor(stage: PipelineStage, error: unknown) {
    const causeMessage =
      error instanceof Error ? error.message : "Pipeline stage failed";

    super(causeMessage);
    this.name = "P0PipelineStageError";
    this.stage = stage;
    this.causeMessage = causeMessage;

    const statusCode =
      error instanceof Error && "statusCode" in error
        ? Number(error.statusCode)
        : 500;

    this.statusCode = Number.isFinite(statusCode) ? statusCode : 500;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const getSampleFileId = (payload: P0PipelineRequest): string | undefined => {
  return normalizeOptionalString(payload.sample_file_id ?? payload.sampleFileId);
};

const getValidatedSampleAnalysis = (
  payload: P0PipelineRequest
): SampleAnalysis | undefined => {
  const rawSampleAnalysis = payload.sample_analysis ?? payload.sampleAnalysis;

  if (!rawSampleAnalysis) {
    return undefined;
  }

  const validationResult = validateSchema("sample_analysis", rawSampleAnalysis);
  if (!validationResult.valid) {
    throw new P0PipelineInputError(
      `sample_analysis is invalid: ${JSON.stringify(validationResult.errors)}`
    );
  }

  return rawSampleAnalysis as SampleAnalysis;
};

const isMaterialInput = (value: unknown): value is MaterialInput => {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isRecord(value.target) &&
    typeof value.target.target_topic === "string" &&
    Array.isArray(value.selling_points) &&
    Array.isArray(value.uploaded_files) &&
    Array.isArray(value.text_assets)
  );
};

const createMaterialInputPayload = (
  payload: P0PipelineRequest
): CreateMaterialInputPayload => {
  const rawMaterialInput = payload.material_input ?? payload.materialInput;

  if (isRecord(rawMaterialInput) && !isMaterialInput(rawMaterialInput)) {
    return rawMaterialInput as CreateMaterialInputPayload;
  }

  return {
    target_topic: payload.target_topic ?? payload.targetTopic,
    target_audience: payload.target_audience ?? payload.targetAudience,
    product_name: payload.product_name ?? payload.productName,
    creative_brief: payload.creative_brief ?? payload.creativeBrief,
    selling_points: payload.selling_points ?? payload.sellingPoints,
    uploaded_file_ids: payload.uploaded_file_ids ?? payload.uploadedFileIds,
    text_assets: payload.text_assets ?? payload.textAssets
  };
};

const getMaterialInput = (payload: P0PipelineRequest): MaterialInput => {
  const rawMaterialInput = payload.material_input ?? payload.materialInput;

  if (isMaterialInput(rawMaterialInput)) {
    return rawMaterialInput;
  }

  try {
    return createMaterialInput(createMaterialInputPayload(payload));
  } catch (error) {
    if (error instanceof MaterialInputValidationError) {
      throw new P0PipelineInputError(error.message);
    }

    throw error;
  }
};

const getSellingPointTexts = (materialInput: MaterialInput): string[] => {
  return materialInput.selling_points
    .sort((left, right) => left.priority - right.priority)
    .map((point) => point.text);
};

const getOptionalBoolean = (value: unknown): boolean => {
  return value === true;
};

const getOptionalNumber = (value: unknown): number | undefined => {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const runStage = async <T>(
  stage: PipelineStage,
  operation: () => T | Promise<T>
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof P0PipelineStageError) {
      throw error;
    }

    throw new P0PipelineStageError(stage, error);
  }
};

export const runP0Pipeline = async (
  payload: P0PipelineRequest
): Promise<P0PipelineResult> => {
  const sampleFileId = getSampleFileId(payload);
  const providedSampleAnalysis = getValidatedSampleAnalysis(payload);

  const sampleAnalysis = await runStage("sample_analyze", async () => {
    if (providedSampleAnalysis) {
      return providedSampleAnalysis;
    }

    if (!sampleFileId) {
      throw new P0PipelineInputError(
        "Request body must include sample_file_id or sample_analysis"
      );
    }

    return analyzeSampleVideo(sampleFileId);
  });

  const structureBlueprint = await runStage("structure_extract", () =>
    extractStructureBlueprint({
      sampleAnalysis,
      vertical: normalizeOptionalString(payload.vertical),
      category: normalizeOptionalString(payload.category),
      useMock: getOptionalBoolean(payload.use_mock ?? payload.useMock)
    })
  );

  const materialInput = await runStage("material_input", () =>
    getMaterialInput(payload)
  );

  const materialAnalysis = await runStage("material_analyze", () =>
    analyzeMaterialInput({
      material_input: materialInput
    })
  );

  const slotMapping = await runStage("structure_migrate", () =>
    migrateStructureToMaterials({
      structure_blueprint: structureBlueprint,
      material_analysis: materialAnalysis,
      target_topic: materialInput.target.target_topic,
      selling_points: getSellingPointTexts(materialInput)
    })
  );

  const confidenceThreshold = getOptionalNumber(
    payload.confidence_threshold ?? payload.confidenceThreshold
  );

  const gapReport = await runStage("gap_detect", () =>
    detectGapsFromSlotMapping({
      slot_mapping: slotMapping,
      confidence_threshold: confidenceThreshold
    })
  );

  const fillStrategies = await runStage("gap_fill_strategy", () =>
    generateGapFillStrategies({
      gap_report: gapReport,
      target_topic: materialInput.target.target_topic
    })
  );

  const timelinePlan = await runStage("timeline_generate", () =>
    generateTimelinePlan({
      structure_blueprint: structureBlueprint,
      slot_mapping: slotMapping,
      gap_report: gapReport,
      fill_strategies: fillStrategies
    })
  );

  return {
    id: `p0_pipeline_${sampleAnalysis.id}_${materialInput.id}`,
    version: "0.1.0",
    created_at: new Date().toISOString(),
    source: {
      type: "rule",
      model: "rule_based_p0_pipeline_v0.1"
    },
    input: {
      sample_source: providedSampleAnalysis
        ? "provided_sample_analysis"
        : "uploaded_video",
      ...(sampleFileId ? { sample_file_id: sampleFileId } : {}),
      material_input_ref: materialInput.id
    },
    stages: {
      sample_analysis: sampleAnalysis,
      structure_blueprint: structureBlueprint,
      material_input: materialInput,
      material_analysis: materialAnalysis,
      slot_mapping: slotMapping,
      gap_report: gapReport,
      fill_strategies: fillStrategies,
      timeline_plan: timelinePlan
    },
    summary: {
      status: "completed",
      stage_count: 8,
      total_slots: slotMapping.summary.total_slots,
      total_gaps: gapReport.summary.total_gaps,
      timeline_duration_seconds: timelinePlan.target_video.duration_seconds,
      timeline_item_count: timelinePlan.timeline.length,
      notes: "P0 后端链路已串联完成，返回结果保留每个阶段中间产物，前端可按 stages 分步可视化。"
    }
  };
};
