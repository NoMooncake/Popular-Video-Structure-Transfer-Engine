export type JsonObject = Record<string, unknown>;

export type V2VideoRef = {
  file_id?: string;
  uri?: string;
  role: "reference_sample" | "user_material";
  label?: string;
};

export type V2TextAsset = {
  asset_id?: string;
  type: "brief" | "copy" | "note" | "requirement" | "other";
  content: string;
};

export type V2UserRequest = {
  goal: string;
  target_audience?: string;
  product_name?: string;
  style_preferences?: string[];
  must_include?: string[];
  avoid?: string[];
};

export type V2PipelineRequest = {
  reference_videos?: V2VideoRef[];
  reference_file_ids?: string[];
  user_materials?: V2VideoRef[];
  user_material_file_ids?: string[];
  text_assets?: V2TextAsset[];
  user_request: V2UserRequest;
  options?: {
    image_candidate_count?: number;
    generate_image_candidates?: boolean;
    target_duration_seconds?: number;
    allow_fallback?: boolean;
    accepted_duration_short_slots?: string[];
  };
};

export type V2ProviderCallResult = {
  provider: string;
  model: string;
  task: string;
  output: JsonObject;
};

export type V2ImageCandidate = {
  candidate_id: string;
  prompt_ref: string;
  uri?: string;
  provider_response: JsonObject;
};

export type V2MaterialCoverage = {
  materials_sufficient: boolean;
  requires_ai_completion: boolean;
  target_duration_seconds: number;
  total_known_material_duration_seconds: number;
  hard_constraints: {
    total_duration_coverage_passed: boolean;
    notes: string[];
  };
  material_assets: JsonObject[];
  slot_coverage: JsonObject[];
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
    reference_video_analyses: JsonObject[];
    user_material_analysis: JsonObject;
    fillable_architecture: JsonObject;
    material_coverage: V2MaterialCoverage;
    production_plan: JsonObject;
    image_candidates?: V2ImageCandidate[];
  };
  summary: {
    status: "completed";
    needs_user_image_approval: boolean;
    can_generate_video_directly: boolean;
    target_duration_seconds: number;
    notes: string;
  };
};

export type V2ImageCandidateRequest = {
  prompt?: string;
  image_prompt?: string;
  prompt_package?: JsonObject;
  count?: number;
  allow_fallback?: boolean;
  reference_images?: string[];
  reference_video_uris?: string[];
  reference_videos?: V2VideoRef[];
};

export type V2ImageToVideoRequest = {
  approved_image_uri: string;
  video_prompt: string;
  duration_seconds?: number;
  target_duration_seconds?: number;
  aspect_ratio?: string;
  slot_id?: string;
  slot_type?: string;
  slot_description?: string;
  auto_trim_review?: boolean;
  camera_fixed?: boolean;
  watermark?: boolean;
  allow_fallback?: boolean;
};

export type V2GeneratedVideoTrimReviewRequest = {
  video_uri: string;
  slot_id?: string;
  slot_type?: string;
  target_duration_seconds: number;
  generation_prompt?: string;
  slot_description?: string;
  trim_video?: boolean;
  allow_fallback?: boolean;
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
};
