import gapReportJson from "../../../../examples/case_01/gap_report.mock.json";
import sampleAnalysisJson from "../../../../examples/case_01/sample_analysis.mock.json";
import structureBlueprintJson from "../../../../examples/case_01/structure_blueprint.mock.json";
import timelinePlanJson from "../../../../examples/case_01/timeline_plan.mock.json";

import type {
  CanvasBlock,
  GapItem,
  GapReport,
  MatchStatus,
  SampleAnalysis,
  StructureBlueprint,
  TimelineItem,
  TimelinePlan,
  V2MaterialCoverageSlot,
  V2PipelineResult
} from "../types";

export const structureBlueprint = structureBlueprintJson as StructureBlueprint;
export const gapReport = gapReportJson as GapReport;
export const timelinePlan = timelinePlanJson as TimelinePlan;

export const sampleAnalysis = sampleAnalysisJson as SampleAnalysis;

const statusBySlotId: Record<string, MatchStatus> = {
  slot_01: "partial",
  slot_02: "matched",
  slot_03: "matched",
  slot_04: "partial",
  slot_05: "matched",
  slot_06: "partial"
};

const gapBySlotId = new Map<string, GapItem>(
  gapReport.gaps.map((gap) => [gap.slot_id, gap])
);

const timelineBySlotId = new Map<string, TimelineItem>(
  timelinePlan.timeline.map((item) => [item.slot_id, item])
);

const formatTimeRange = (timeRange: CanvasBlock["slot"]["time_range"]): string => {
  if (typeof timeRange === "string") {
    return timeRange;
  }

  return `${timeRange.start_seconds}-${timeRange.end_seconds}s`;
};

const getV2AssignedMaterials = (slot: V2MaterialCoverageSlot) => {
  const seen = new Set<string>();
  return [
    ...(slot.assigned_segments ?? []),
    ...(slot.matched_material_segments ?? []),
    ...(slot.assigned_materials ?? [])
  ].filter((material) => {
    const key = [
      material.segment_id,
      material.material_id,
      material.source_material_id,
      material.file_id,
      material.uri,
      material.source_in_seconds,
      material.source_out_seconds
    ].join(":");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const hasV2AssignedSegment = (slot: V2MaterialCoverageSlot): boolean =>
  getV2AssignedMaterials(slot).some((material) => {
    const start = material.source_in_seconds ?? material.start_seconds;
    const end = material.source_out_seconds ?? material.end_seconds;
    return (
      Boolean(material.time_range) ||
      (typeof start === "number" && typeof end === "number" && end > start) ||
      (typeof material.matched_material_duration === "number" &&
        material.matched_material_duration > 0)
    );
  });

export const createCanvasBlocks = (blueprint: StructureBlueprint): CanvasBlock[] => blueprint.slots.map((slot) => ({
  id: slot.slot_id,
  label: slot.slot_type,
  timeRange: formatTimeRange(slot.time_range),
  status: statusBySlotId[slot.slot_id] ?? "missing",
  migrationResult: slot.migration_rule,
  materialSummary: timelineBySlotId.get(slot.slot_id)?.visual_description ?? "待匹配素材",
  copy: timelineBySlotId.get(slot.slot_id)?.subtitle || timelineBySlotId.get(slot.slot_id)?.voiceover || "待生成文案",
  slot,
  gap: gapBySlotId.get(slot.slot_id),
  timeline: timelineBySlotId.get(slot.slot_id)
}));

const toV2MatchStatus = (slot: V2MaterialCoverageSlot): MatchStatus => {
  if (slot.frontend_coverage_status === "fully_matched" || slot.coverage_status === "covered") {
    return "matched";
  }

  if (hasV2AssignedSegment(slot)) {
    return "partial";
  }

  if (
    slot.frontend_coverage_status === "structure_complete_duration_short" ||
    slot.coverage_status === "partial" ||
    slot.coverage_status === "duration_unknown"
  ) {
    return "partial";
  }

  return "missing";
};

const formatV2Duration = (slot: V2MaterialCoverageSlot): string => {
  const displayText = slot.frontend_display?.duration_text;
  if (displayText) {
    return displayText;
  }

  const duration = Number(slot.required_duration);
  return Number.isFinite(duration) ? `${duration}s` : "0s";
};

const normalizeV2Copy = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "待生成文案") {
    return undefined;
  }

  return trimmed;
};

const getV2FallbackCopy = (slot: V2MaterialCoverageSlot): string => {
  const focus =
    slot.frontend_display?.shot_description ||
    slot.visual_goal ||
    slot.frontend_display?.migration_result_description ||
    slot.slot_name ||
    slot.slot_type;

  if (/hook/iu.test(slot.slot_type)) {
    return "先用一句话抓住注意力，突出产品最直接的吸引点。";
  }

  if (/cta|action/iu.test(slot.slot_type)) {
    return "收束核心卖点，引导观众继续了解产品。";
  }

  return `突出${focus}，让观众快速理解这一段的产品卖点。`;
};

const getV2Copy = (slot: V2MaterialCoverageSlot): string =>
  normalizeV2Copy(slot.frontend_display?.copy) ||
  normalizeV2Copy(slot.copy_direction) ||
  getV2FallbackCopy(slot);

const toV2StructureSlot = (slot: V2MaterialCoverageSlot): CanvasBlock["slot"] => ({
  slot_id: slot.slot_id,
  slot_type: slot.slot_type,
  time_range: formatV2Duration(slot),
  content_goal: slot.visual_goal ?? slot.frontend_display?.shot_description ?? slot.slot_name ?? slot.slot_type,
  rhythm: "medium",
  required_materials: [
    {
      type: "user_material",
      description: slot.gap_reason ?? slot.frontend_display?.material_summary ?? "",
      priority: "required"
    }
  ],
  packaging_features: [],
  migration_rule:
    slot.frontend_display?.migration_result_description ??
    slot.frontend_display?.shot_description ??
    slot.visual_goal ??
    slot.slot_name ??
    slot.slot_type,
  source_evidence: [
    slot.frontend_display?.material_status,
    slot.frontend_coverage_label,
    slot.gap_reason
  ].filter((item): item is string => Boolean(item)),
  confidence: 0.8
});

const toV2Gap = (slot: V2MaterialCoverageSlot): GapItem | undefined => {
  if (toV2MatchStatus(slot) === "matched") {
    return undefined;
  }

  return {
    gap_id: `${slot.slot_id}_v2_gap`,
    slot_id: slot.slot_id,
    slot_type: slot.slot_type,
    missing: slot.gap_reason ?? slot.frontend_display?.material_status ?? slot.frontend_coverage_label,
    impact:
      slot.recommended_video_prompt?.prompt_description ??
      slot.recommended_aigc_prompt?.prompt_description ??
      slot.frontend_display?.material_summary ??
      slot.gap_reason ??
      slot.frontend_coverage_label,
    severity: slot.frontend_coverage_status === "material_insufficient" ? "high" : "medium",
    strategy:
      slot.recommended_video_prompt?.prompt ??
      slot.recommended_aigc_prompt?.prompt ??
      slot.frontend_coverage_label,
    fill_options: [
      {
        type: "material_reuse",
        description: slot.frontend_display?.material_summary ?? slot.frontend_coverage_label,
        priority: "primary"
      },
      {
        type: "packaging",
        description:
          slot.recommended_aigc_prompt?.prompt_description ??
          slot.recommended_video_prompt?.prompt_description ??
          slot.frontend_coverage_label
      }
    ]
  };
};

const toV2TimelineItem = (
  slot: V2MaterialCoverageSlot,
  timeRange: string,
  gap?: GapItem
): TimelineItem => {
  const copy = getV2Copy(slot);

  return {
    item_id: `tl_${slot.slot_id}`,
    slot_id: slot.slot_id,
    time_range: timeRange,
    slot_type: slot.slot_type,
    content_goal: slot.visual_goal ?? slot.frontend_display?.shot_description ?? slot.slot_name ?? slot.slot_type,
    visual_source: hasV2AssignedSegment(slot) ? "user_material" : "generated_graphic",
    visual_description:
      slot.frontend_display?.material_summary ??
      slot.recommended_video_prompt?.prompt_description ??
      slot.recommended_aigc_prompt?.prompt_description ??
      "",
    subtitle: copy,
    voiceover: copy,
    gap_ref: gap?.gap_id,
    transition: "none"
  };
};

export const createCanvasBlocksFromV2Coverage = (
  slots: V2MaterialCoverageSlot[],
  sourceId?: string
): CanvasBlock[] => {
  return slots.map((slot) => {
    const timeRange = formatV2Duration(slot);
    const gap = toV2Gap(slot);
    const structureSlot = toV2StructureSlot(slot);
    const timeline = toV2TimelineItem(slot, timeRange, gap);

    return {
      id: slot.slot_id,
      label:
        slot.frontend_display?.migration_result_title ??
        slot.slot_name ??
        slot.slot_type,
      timeRange,
      status: toV2MatchStatus(slot),
      migrationResult: structureSlot.migration_rule,
      materialSummary: timeline.visual_description || slot.frontend_coverage_label,
      copy: timeline.subtitle || timeline.voiceover,
      slot: structureSlot,
      gap,
      timeline,
      v2: {
        coverageSlot: slot,
        sourcePipelineId: sourceId
      }
    };
  });
};

export const createCanvasBlocksFromV2Pipeline = (
  pipelineResult: V2PipelineResult
): CanvasBlock[] => createCanvasBlocksFromV2Coverage(
  pipelineResult.stages.material_coverage.slot_coverage,
  pipelineResult.id
);

export const canvasBlocks: CanvasBlock[] = createCanvasBlocks(structureBlueprint);

export const steps = [
  {
    key: "input",
    label: "输入",
    description: "上传样例、多条参考视频和真实素材"
  },
  {
    key: "analysis",
    label: "样例解析",
    description: "按样例视频拆结构段落"
  },
  {
    key: "migration",
    label: "结构迁移",
    description: "映射我的素材和迁移结果"
  },
  {
    key: "gap-fill",
    label: "缺口补全",
    description: "红黄绿匹配状态和补全策略"
  },
  {
    key: "demo",
    label: "演示",
    description: "时间线预览、人工编辑和导出占位"
  }
] as const;
