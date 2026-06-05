import gapReportJson from "../../../../examples/case_01/gap_report.mock.json";
import sampleAnalysisJson from "../../../../examples/case_01/sample_analysis.mock.json";
import structureBlueprintJson from "../../../../examples/case_01/structure_blueprint.mock.json";
import timelinePlanJson from "../../../../examples/case_01/timeline_plan.mock.json";

import type {
  CanvasBlock,
  GapItem,
  GapReport,
  Keyframe,
  MatchStatus,
  StructureBlueprint,
  TimelineItem,
  TimelinePlan
} from "../types";

export const structureBlueprint = structureBlueprintJson as StructureBlueprint;
export const gapReport = gapReportJson as GapReport;
export const timelinePlan = timelinePlanJson as TimelinePlan;

type SampleAnalysis = {
  keyframes: Keyframe[];
};

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

export const canvasBlocks: CanvasBlock[] = structureBlueprint.slots.map((slot) => ({
  id: slot.slot_id,
  label: slot.slot_type,
  timeRange: formatTimeRange(slot.time_range),
  status: statusBySlotId[slot.slot_id] ?? "missing",
  slot,
  gap: gapBySlotId.get(slot.slot_id),
  timeline: timelineBySlotId.get(slot.slot_id)
}));

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
    key: "gap-detail",
    label: "缺口详情",
    description: "逐项解释缺什么、为什么缺、怎么补"
  },
  {
    key: "demo",
    label: "演示",
    description: "时间线预览、人工编辑和导出占位"
  }
] as const;
