import type { StructureBlueprint, UploadResponse } from "../types";

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
