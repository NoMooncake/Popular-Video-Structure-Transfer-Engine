export type MatchStatus = "missing" | "partial" | "matched";

export type StepKey =
  | "input"
  | "analysis"
  | "migration"
  | "gap-fill"
  | "gap-detail"
  | "demo";

export type UploadedVideoFile = {
  file_id: string;
  filename: string;
  original_filename: string;
  path: string;
  mime_type: string;
  size: number;
};

export type UploadResponse = {
  files: UploadedVideoFile[];
};

export type Keyframe = {
  frame_id: string;
  time_seconds: number;
  media: {
    uri: string;
    mime_type: "image/jpeg";
    width: number;
    height: number;
  };
};

export type TimeRange = {
  start_seconds: number;
  end_seconds: number;
  relative_start_percent: number;
  relative_end_percent: number;
};

export type SampleShot = {
  shot_id: string;
  time_range: TimeRange;
  keyframe_refs: string[];
  visual_tags: string[];
  description: string;
  confidence: number;
};

export type SampleAnalysis = {
  id: string;
  video: {
    duration_seconds: number;
    width: number;
    height: number;
    resolution: string;
    aspect_ratio: string;
    fps: number;
    codec: string;
    format: string;
    path?: string;
    cover_frame: {
      uri: string;
      mime_type: string;
      width: number;
      height: number;
    };
  };
  shot_count: number;
  shots: SampleShot[];
  keyframes: Keyframe[];
};

export type StructureSlot = {
  slot_id: string;
  slot_type: string;
  time_range: string | TimeRange;
  content_goal: string;
  rhythm: "slow" | "medium" | "fast" | "mixed";
  required_materials: Array<{
    type: string;
    description: string;
    priority: "required" | "recommended" | "optional";
  }>;
  packaging_features: Array<{
    type: string;
    description: string;
    style: string;
  }>;
  migration_rule: string;
  source_evidence: string[];
  confidence: number;
};

export type StructureBlueprint = {
  id: string;
  summary: string;
  slots: StructureSlot[];
  packaging_summary: {
    subtitle_density: string;
    title_style: string;
    highlight_style: string;
    transition_style: string;
    cover_style: string;
  };
};

export type GapItem = {
  gap_id: string;
  slot_id: string;
  slot_type: string;
  missing: string;
  impact: string;
  severity: "low" | "medium" | "high";
  strategy: string;
  fill_options: Array<{
    type: string;
    description: string;
    priority?: "primary";
  }>;
};

export type GapReport = {
  id: string;
  summary: {
    total_gaps: number;
    blocking_gaps: number;
    overall_status: string;
    notes: string;
  };
  gaps: GapItem[];
};

export type TimelineItem = {
  item_id: string;
  slot_id: string;
  time_range: string;
  slot_type: string;
  content_goal: string;
  visual_source: string;
  visual_description: string;
  subtitle: string;
  voiceover: string;
  gap_ref?: string;
  transition: string;
};

export type TimelinePlan = {
  id: string;
  target_video: {
    duration_seconds: number;
    aspect_ratio: string;
    platform_style: string;
    title: string;
  };
  script: {
    title: string;
    summary: string;
    full_text: string;
  };
  timeline: TimelineItem[];
};

export type CanvasBlock = {
  id: string;
  label: string;
  timeRange: string;
  status: MatchStatus;
  slot: StructureSlot;
  gap?: GapItem;
  timeline?: TimelineItem;
};
