import type { StructureBlueprint, UploadResponse, V2PipelineResult } from "../types";

type ApiErrorBody = {
  error?: {
    message?: string;
  };
};

const getErrorMessage = (body: unknown, fallback: string): string => {
  if (!body || typeof body !== "object" || !("error" in body)) {
    return fallback;
  }

  const errorBody = body as ApiErrorBody;
  return errorBody.error?.message || fallback;
};

const toJson = async <T>(response: Response): Promise<T> => {
  const body = (await response.json()) as unknown;

  if (!response.ok) {
    throw new Error(getErrorMessage(body, `Request failed with ${response.status}`));
  }

  return body as T;
};

export const uploadSampleVideos = async (files: File[]): Promise<UploadResponse> => {
  const formData = new FormData();
  for (const file of files) {
    formData.append(files.length === 1 ? "file" : "files", file);
  }

  const endpoint = files.length === 1 ? "/api/upload/video" : "/api/upload/videos";
  return toJson<UploadResponse>(
    await fetch(endpoint, {
      method: "POST",
      body: formData
    })
  );
};

export const analyzeSampleVideo = async <T>(fileId: string): Promise<T> => {
  return toJson<T>(
    await fetch("/api/sample/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        file_id: fileId
      })
    })
  );
};

export const extractStructureBlueprint = async (
  sampleAnalysis: unknown
): Promise<StructureBlueprint> => {
  return toJson<StructureBlueprint>(
    await fetch("/api/structure/extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sample_analysis: sampleAnalysis,
        vertical: "seeding_de_seeding",
        category: "pet_food"
      })
    })
  );
};

export type V2PipelineAnalyzeRequest = {
  reference_file_ids?: string[];
  user_material_file_ids?: string[];
  reference_videos?: Array<{
    file_id?: string;
    uri?: string;
    role: "reference_sample" | "user_material";
    label?: string;
  }>;
  user_materials?: Array<{
    file_id?: string;
    uri?: string;
    role: "reference_sample" | "user_material";
    label?: string;
  }>;
  text_assets?: Array<{
    asset_id?: string;
    type: "brief" | "copy" | "note" | "requirement" | "other";
    content: string;
  }>;
  user_request: {
    goal: string;
    target_audience?: string;
    product_name?: string;
    style_preferences?: string[];
    must_include?: string[];
    avoid?: string[];
  };
  options?: {
    image_candidate_count?: number;
    generate_image_candidates?: boolean;
    target_duration_seconds?: number;
    allow_fallback?: boolean;
    accepted_duration_short_slots?: string[];
  };
};

export type V2ImageCandidateRequest = {
  prompt?: string;
  image_prompt?: string;
  prompt_package?: Record<string, unknown>;
  count?: number;
  allow_fallback?: boolean;
  reference_images?: string[];
  reference_video_uris?: string[];
};

export type V2ImageToVideoRequest = {
  approved_image_uri?: string;
  source_image_uri?: string;
  image_uri?: string;
  source_video_uri?: string;
  video_prompt: string;
  generation_mode?: "direct_from_material_frame" | "uploaded_image" | "generated_image";
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

export const getV2Status = async <T = unknown>(): Promise<T> => {
  return toJson<T>(await fetch("/api/v2/status"));
};

export const analyzeV2Pipeline = async (
  payload: V2PipelineAnalyzeRequest
): Promise<V2PipelineResult> => {
  return toJson<V2PipelineResult>(
    await fetch("/api/v2/pipeline/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    })
  );
};

export const generateV2ImageCandidates = async <T = unknown>(
  payload: V2ImageCandidateRequest
): Promise<T> => {
  return toJson<T>(
    await fetch("/api/v2/generation/image-candidates", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    })
  );
};

export const generateV2ImageToVideo = async <T = unknown>(
  payload: V2ImageToVideoRequest
): Promise<T> => {
  return toJson<T>(
    await fetch("/api/v2/generation/image-to-video", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    })
  );
};
