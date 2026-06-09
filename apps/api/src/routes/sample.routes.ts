import { Router, type Response } from "express";

import {
  analyzeSampleVideos,
  analyzeSampleVideo,
  UploadedSampleNotFoundError
} from "../services/sampleAnalyzeService.js";

export const sampleRoutes = Router();

const getStatusCode = (error: unknown): number => {
  const statusCode =
    error instanceof Error && "statusCode" in error
      ? Number(error.statusCode)
      : 500;

  return Number.isFinite(statusCode) ? statusCode : 500;
};

const handleSampleAnalyzeError = (
  res: Response,
  error: unknown,
  code: string,
  fallbackMessage: string
): void => {
  if (error instanceof UploadedSampleNotFoundError) {
    res.status(error.statusCode).json({
      error: {
        code: "file_not_found",
        message: error.message
      }
    });
    return;
  }

  const message = error instanceof Error ? error.message : fallbackMessage;

  res.status(getStatusCode(error)).json({
    error: {
      code,
      message
    }
  });
};

const readFileIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((fileId) => (typeof fileId === "string" ? fileId.trim() : ""))
    .filter(Boolean);
};

sampleRoutes.post("/analyze", async (req, res) => {
  const fileIds = readFileIds(req.body?.file_ids || req.body?.fileIds);
  const fileId = req.body?.file_id || req.body?.fileId;

  if (fileIds.length > 0) {
    try {
      const sampleAnalysisBatch = await analyzeSampleVideos(fileIds);
      res.json(sampleAnalysisBatch);
    } catch (error) {
      handleSampleAnalyzeError(
        res,
        error,
        "sample_analyze_batch_failed",
        "Failed to analyze sample videos"
      );
    }
    return;
  }

  if (typeof fileId !== "string" || fileId.trim().length === 0) {
    res.status(400).json({
      error: {
        code: "missing_file_id",
        message: "Request body must include file_id or file_ids"
      }
    });
    return;
  }

  try {
    const sampleAnalysis = await analyzeSampleVideo(fileId.trim());
    res.json(sampleAnalysis);
  } catch (error) {
    handleSampleAnalyzeError(
      res,
      error,
      "sample_analyze_failed",
      "Failed to analyze sample video"
    );
  }
});

sampleRoutes.post("/analyze/batch", async (req, res) => {
  const fileIds = readFileIds(req.body?.file_ids || req.body?.fileIds);

  if (fileIds.length === 0) {
    res.status(400).json({
      error: {
        code: "missing_file_ids",
        message: "Request body must include a non-empty file_ids array"
      }
    });
    return;
  }

  try {
    const sampleAnalysisBatch = await analyzeSampleVideos(fileIds);
    res.json(sampleAnalysisBatch);
  } catch (error) {
    handleSampleAnalyzeError(
      res,
      error,
      "sample_analyze_batch_failed",
      "Failed to analyze sample videos"
    );
  }
});
