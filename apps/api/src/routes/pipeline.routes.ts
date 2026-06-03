import { Router } from "express";

import {
  P0PipelineInputError,
  P0PipelineStageError,
  runP0Pipeline
} from "../services/p0PipelineService.js";

export const pipelineRoutes = Router();

pipelineRoutes.post("/p0", async (req, res) => {
  try {
    const pipelineResult = await runP0Pipeline(req.body ?? {});
    res.json(pipelineResult);
  } catch (error) {
    if (error instanceof P0PipelineStageError) {
      res.status(error.statusCode).json({
        error: {
          code: "pipeline_stage_failed",
          stage: error.stage,
          message: error.causeMessage
        }
      });
      return;
    }

    if (error instanceof P0PipelineInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_pipeline_input",
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
        code: "p0_pipeline_failed",
        message:
          error instanceof Error ? error.message : "Failed to run P0 pipeline"
      }
    });
  }
});
