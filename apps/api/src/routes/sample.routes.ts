import { Router } from "express";

import {
  analyzeSampleVideo,
  UploadedSampleNotFoundError
} from "../services/sampleAnalyzeService.js";

export const sampleRoutes = Router();

sampleRoutes.post("/analyze", async (req, res) => {
  const fileId = req.body?.file_id || req.body?.fileId;

  if (typeof fileId !== "string" || fileId.trim().length === 0) {
    res.status(400).json({
      error: {
        code: "missing_file_id",
        message: "Request body must include file_id"
      }
    });
    return;
  }

  try {
    const sampleAnalysis = await analyzeSampleVideo(fileId.trim());
    res.json(sampleAnalysis);
  } catch (error) {
    if (error instanceof UploadedSampleNotFoundError) {
      res.status(error.statusCode).json({
        error: {
          code: "file_not_found",
          message: error.message
        }
      });
      return;
    }

    const statusCode =
      error instanceof Error && "statusCode" in error
        ? Number(error.statusCode)
        : 500;
    const message =
      error instanceof Error ? error.message : "Failed to analyze sample video";

    res.status(Number.isFinite(statusCode) ? statusCode : 500).json({
      error: {
        code: "sample_analyze_failed",
        message
      }
    });
  }
});
