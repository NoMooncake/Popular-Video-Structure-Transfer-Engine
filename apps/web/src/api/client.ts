import type {
  SampleAnalysis,
  StructureBlueprint,
  UploadResponse,
  V2CanvasFinalVideoResult,
  V2FinalAssemblyRequest,
  V2FinalAssemblyResult,
  V2PipelineResult
} from "../types";

type ApiErrorBody = {
  error?: {
    code?: string;
    message?: string;
    stage?: string;
  };
};

export class ApiRequestError extends Error {
  code?: string;
  stage?: string;
  status: number;

  constructor({
    code,
    message,
    stage,
    status
  }: {
    code?: string;
    message: string;
    stage?: string;
    status: number;
  }) {
    super(stage ? `${stage}: ${message}` : message);
    this.name = "ApiRequestError";
    this.code = code;
    this.stage = stage;
    this.status = status;
  }
}

const parseJsonBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      error: {
        message: text
      }
    };
  }
};

const getError = (body: unknown, fallback: string) => {
  if (!body || typeof body !== "object" || !("error" in body)) {
    return {
      message: fallback
    };
  }

  const errorBody = body as ApiErrorBody;
  return {
    code: errorBody.error?.code,
    message: errorBody.error?.message || fallback,
    stage: errorBody.error?.stage
  };
};

const toJson = async <T>(response: Response): Promise<T> => {
  const body = await parseJsonBody(response);

  if (!response.ok) {
    throw new ApiRequestError({
      ...getError(body, `Request failed with ${response.status}`),
      status: response.status
    });
  }

  return body as T;
};

export const uploadSampleVideo = async (file: File): Promise<UploadResponse> => {
  const formData = new FormData();
  formData.append("file", file);

  return toJson<UploadResponse>(
    await fetch("/api/upload/video", {
      method: "POST",
      body: formData
    })
  );
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

export const uploadMaterialFiles = async (files: File[]): Promise<UploadResponse> => {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }

  return toJson<UploadResponse>(
    await fetch("/api/upload/videos", {
      method: "POST",
      body: formData
    })
  );
};

export const analyzeSampleVideo = async (fileId: string): Promise<SampleAnalysis> => {
  return toJson<SampleAnalysis>(
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
  sampleAnalysis: SampleAnalysis,
  options: {
    category?: string;
    useMock?: boolean;
    vertical?: string;
  } = {}
): Promise<StructureBlueprint> => {
  return toJson<StructureBlueprint>(
    await fetch("/api/structure/extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sample_analysis: sampleAnalysis,
        vertical: options.vertical ?? "seeding_de_seeding",
        category: options.category ?? "pet_food",
        use_mock: options.useMock ?? false
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

export const assembleV2FinalVideo = async (
  payload: V2FinalAssemblyRequest
): Promise<V2FinalAssemblyResult> => {
  return toJson<V2FinalAssemblyResult>(
    await fetch("/api/v2/assembly/final-video", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    })
  );
};

export const assembleV2CanvasFinalVideo = async (
  canvasSessionId: string,
  payload: Omit<V2FinalAssemblyRequest, "slots">
): Promise<V2CanvasFinalVideoResult> => {
  return toJson<V2CanvasFinalVideoResult>(
    await fetch(`/api/v2/canvas-sessions/${encodeURIComponent(canvasSessionId)}/final-video`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    })
  );
};
