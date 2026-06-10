export type MatchStatus = "missing" | "partial" | "matched";

export type V2FrontendCoverageStatus =
  | "material_insufficient"
  | "structure_complete_duration_short"
  | "fully_matched";

export type StepKey =
  | "input"
  | "analysis"
  | "migration"
  | "gap-fill"
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

export type V2MaterialAssignment = {
  material_id?: string;
  source_material_id?: string;
  file_id?: string;
  uri?: string;
  label?: string;
  segment_id?: string;
  time_range?: string;
  start_seconds?: number;
  end_seconds?: number;
  final_source_in_seconds?: number;
  final_source_out_seconds?: number;
  source_in_seconds?: number;
  source_out_seconds?: number;
  matched_material_duration?: number;
  duration_seconds?: number;
  usable_duration_seconds?: number;
  visual_description?: string;
  recommended_usage?: string;
  content_summary?: string;
  frames?: Array<{
    frame_id?: string;
    time_seconds?: number;
    uri?: string;
    image_uri?: string;
    public_uri?: string;
    media?: {
      uri?: string;
      mime_type?: string;
    };
  }>;
};

export type CanvasBlock = {
  id: string;
  label: string;
  timeRange: string;
  status: MatchStatus;
  migrationResult: string;
  materialSummary: string;
  copy: string;
  slot: StructureSlot;
  gap?: GapItem;
  timeline?: TimelineItem;
  v2?: {
    coverageSlot?: V2MaterialCoverageSlot;
    canvasNodeId?: string;
    displayKind?: "slot" | "material_segment" | "missing_material";
    parentSlotId?: string;
    sourcePipelineId?: string;
  };
};

export type V2ReferenceAnalysisTableRow = {
  row_id?: string;
  duration?: string;
  sample_video?: {
    frame_id?: string;
    time_seconds?: number;
    media?: {
      uri?: string;
      mime_type?: string;
    };
  };
  shot_description?: {
    title?: string;
    description?: string;
  };
  migration_possibility?: string;
};

export type V2ReferenceAnalysisTable = {
  sample_index?: number;
  file_id?: string;
  source_label?: string;
  frames?: Array<{
    frame_id?: string;
    time_seconds?: number;
    uri?: string;
    source_label?: string;
  }>;
  rows?: V2ReferenceAnalysisTableRow[];
};

export type V2MaterialCoverageSlot = {
  slot_id: string;
  slot_type: string;
  slot_name?: string;
  visual_goal?: string;
  copy_direction?: string;
  voiceover_text?: string;
  text_or_voiceover?: string;
  subtitle_or_voiceover?: string;
  subtitle_or_vo_direction?: string;
  narration_direction?: string;
  caption_text?: string;
  required_duration: number;
  matched_material_duration: number;
  missing_duration: number;
  coverage_status: "covered" | "partial" | "duration_unknown" | "missing" | string;
  frontend_coverage_status: V2FrontendCoverageStatus;
  frontend_coverage_label: string;
  frontend_display?: {
    migration_result_title?: string;
    migration_result_description?: string;
    duration_text?: string;
    shot_description?: string;
    material_summary?: string;
    copy?: string;
    material_status?: string;
  };
  user_duration_short_decision?: "pending" | "accepted_as_sufficient" | "not_applicable";
  ai_completion_required_duration?: number;
  needs_ai_completion?: boolean;
  gap_reason?: string;
  available_user_actions?: string[];
  available_generation_paths?: string[];
  assigned_materials?: V2MaterialAssignment[];
  assigned_segments?: V2MaterialAssignment[];
  matched_material_segments?: V2MaterialAssignment[];
  candidate_material_segments?: V2MaterialAssignment[];
  candidate_materials?: Array<{
    material_id: string;
    label?: string;
    model_label?: string;
    duration_seconds?: number;
    duration_status?: string;
    fit_reason?: string;
    quality?: string;
    candidate_segments?: V2MaterialAssignment[];
  }>;
  direct_video_reference_materials?: Array<{
    material_id: string;
    label?: string;
    uri?: string;
    duration_seconds?: number;
    frame_sample_timestamps_seconds?: number[];
  }>;
  recommended_aigc_prompt?: {
    prompt_ref: string;
    prompt_source: string;
    prompt_description?: string;
    prompt: string;
  };
  recommended_video_prompt?: {
    prompt_ref: string;
    prompt_source: string;
    prompt_description?: string;
    prompt: string;
  };
};

export type V2PipelineResult = {
  id: string;
  version: "2.0.0";
  created_at: string;
  source: {
    type: "api_first_v2";
    multimodal_provider: string;
    image_provider?: string;
    video_provider?: string;
    fallback_used?: boolean;
    fallback_reason?: string;
  };
  input: {
    reference_video_count: number;
    user_material_count: number;
    text_asset_count: number;
  };
  stages: {
    reference_video_analyses: unknown[];
    reference_analysis_tables?: V2ReferenceAnalysisTable[];
    user_material_analysis: Record<string, unknown>;
    fillable_architecture: Record<string, unknown>;
    material_coverage: {
      materials_sufficient: boolean;
      requires_ai_completion: boolean;
      target_duration_seconds: number;
      total_known_material_duration_seconds: number;
      material_assets: Record<string, unknown>[];
      slot_coverage: V2MaterialCoverageSlot[];
    };
    production_plan: Record<string, unknown>;
    image_candidates?: Array<{
      candidate_id: string;
      prompt_ref: string;
      uri?: string;
      provider_response: Record<string, unknown>;
    }>;
  };
  summary: {
    status: "completed";
    needs_user_image_approval: boolean;
    can_generate_video_directly: boolean;
    target_duration_seconds: number;
    notes: string;
  };
};

export type V2FinalAssemblySlot = {
  slot_id?: string;
  slot_type?: string;
  video_uri: string;
  duration_seconds: number;
  start_seconds?: number;
};

export type V2FinalAssemblyRequest = {
  slots: V2FinalAssemblySlot[];
  target_duration_seconds?: number;
  resolution?: string;
  fps?: number;
  background_color?: string;
  allow_loop_short_clips?: boolean;
  generate_bgm?: boolean;
  bgm_prompt?: string;
  bgm_audio_uri?: string;
  bgm_volume?: number;
};

export type V2FinalAssemblyResult = {
  assembly_id: string;
  final_video_url?: string;
  target_duration_seconds?: number;
  planned_duration_seconds?: number;
  final_duration_seconds?: number;
  resolution?: string;
  fps?: number;
  audio_policy?: Record<string, unknown>;
  slots?: Record<string, unknown>[];
};

export type V2CanvasFinalVideoResult = {
  canvas_session?: Record<string, unknown>;
  assembly_slots?: Record<string, unknown>[];
  cover_plan?: Record<string, unknown>;
  final_assembly?: V2FinalAssemblyResult;
};
