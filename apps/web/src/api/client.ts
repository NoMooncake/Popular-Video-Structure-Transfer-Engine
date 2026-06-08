import type { SampleAnalysis, StructureBlueprint, UploadResponse } from "../types";

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
