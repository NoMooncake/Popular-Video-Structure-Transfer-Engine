import { Router } from "express";

import {
  detectGapsFromSlotMapping,
  GapDetectInputError
} from "../services/gapDetectService.js";

export const gapRoutes = Router();

gapRoutes.post("/detect", (req, res) => {
  try {
    const gapReport = detectGapsFromSlotMapping(req.body ?? {});
    res.json(gapReport);
  } catch (error) {
    if (error instanceof GapDetectInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_gap_detect_input",
          message: error.message
        }
      });
      return;
    }

    const statusCode =
      error instanceof Error && "statusCode" in error
        ? Number(error.statusCode)
        : 500;

    res.status(Number.isFinite(statusCode) ? statusCode : 500).json({
      error: {
        code: "gap_detect_failed",
        message:
          error instanceof Error ? error.message : "Failed to detect material gaps"
      }
    });
  }
});
