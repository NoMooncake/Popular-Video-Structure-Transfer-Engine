import { Router } from "express";

import {
  generateTimelinePlan,
  TimelineGenerateInputError
} from "../services/timelineGenerateService.js";

export const generateRoutes = Router();

generateRoutes.post("/timeline", (req, res) => {
  try {
    const timelinePlan = generateTimelinePlan(req.body ?? {});
    res.json(timelinePlan);
  } catch (error) {
    if (error instanceof TimelineGenerateInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_timeline_generate_input",
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
        code: "timeline_generation_failed",
        message:
          error instanceof Error
            ? error.message
            : "Failed to generate timeline plan"
      }
    });
  }
});
