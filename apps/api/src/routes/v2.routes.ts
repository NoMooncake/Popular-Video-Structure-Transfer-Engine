import { Router } from "express";

import { config } from "../config/index.js";
import {
  generateV2ImageCandidates,
  generateV2ImageToVideo,
  runV2Pipeline,
  V2PipelineInputError
} from "../services/v2PipelineService.js";

export const v2Routes = Router();

const getStatusCode = (error: unknown): number => {
  const statusCode =
    error instanceof Error && "statusCode" in error
      ? Number(error.statusCode)
      : 500;

  return Number.isFinite(statusCode) ? statusCode : 500;
};

const getErrorMessage = (error: unknown, fallback: string): string => {
  return error instanceof Error ? error.message : fallback;
};

v2Routes.get("/status", (_req, res) => {
  res.json({
    version: "2.0.0",
    vertical: "commercial_advertising",
    target_duration_seconds_default: 30,
    mode: "api_first_with_fallback",
    providers: {
      multimodal: {
        provider: config.providers.v2.multimodal.provider,
        model_configured: Boolean(config.providers.v2.multimodal.model),
        enabled: config.providers.v2.multimodal.enabled
      },
      image: {
        provider: config.providers.v2.image.provider,
        model_configured: Boolean(config.providers.v2.image.model),
        enabled: config.providers.v2.image.enabled
      },
      video: {
        provider: config.providers.v2.video.provider,
        model_configured: Boolean(config.providers.v2.video.model),
        enabled: config.providers.v2.video.enabled
      }
    },
    fallback: {
      default_enabled: true,
      disable_with: {
        options: {
          allow_fallback: false
        }
      }
    }
  });
});

v2Routes.post("/pipeline/analyze", async (req, res) => {
  try {
    const result = await runV2Pipeline(req.body ?? {});
    res.json(result);
  } catch (error) {
    if (error instanceof V2PipelineInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_v2_pipeline_input",
          message: error.message
        }
      });
      return;
    }

    res.status(getStatusCode(error)).json({
      error: {
        code: "v2_pipeline_failed",
        message: getErrorMessage(error, "Failed to run V2 pipeline")
      }
    });
  }
});

v2Routes.post("/generation/image-candidates", async (req, res) => {
  try {
    const result = await generateV2ImageCandidates(req.body ?? {});
    res.json(result);
  } catch (error) {
    if (error instanceof V2PipelineInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_v2_image_candidate_input",
          message: error.message
        }
      });
      return;
    }

    res.status(getStatusCode(error)).json({
      error: {
        code: "v2_image_candidate_generation_failed",
        message: getErrorMessage(error, "Failed to generate V2 image candidates")
      }
    });
  }
});

v2Routes.post("/generation/image-to-video", async (req, res) => {
  try {
    const result = await generateV2ImageToVideo(req.body ?? {});
    res.json(result);
  } catch (error) {
    if (error instanceof V2PipelineInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_v2_image_to_video_input",
          message: error.message
        }
      });
      return;
    }

    res.status(getStatusCode(error)).json({
      error: {
        code: "v2_image_to_video_failed",
        message: getErrorMessage(error, "Failed to run V2 image-to-video")
      }
    });
  }
});
