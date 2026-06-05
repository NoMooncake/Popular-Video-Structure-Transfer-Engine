import { Router } from "express";

import { config } from "../config/index.js";
import {
  findV2GeneratedVideoReviewFile,
  generateV2ImageCandidates,
  generateV2ImageToVideo,
  getV2VideoGenerationTask,
  reviewAndTrimV2GeneratedVideo,
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
    image_candidate_count_default: 4,
    image_candidate_count_max: 6,
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
        message: getErrorMessage(error, "V2 pipeline 执行失败")
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
        message: getErrorMessage(error, "V2 图片候选生成失败")
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
        message: getErrorMessage(error, "V2 图生视频执行失败")
      }
    });
  }
});

v2Routes.post("/generation/video-trim-review", async (req, res) => {
  try {
    const result = await reviewAndTrimV2GeneratedVideo(req.body ?? {});
    res.json(result);
  } catch (error) {
    if (error instanceof V2PipelineInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_v2_video_trim_review_input",
          message: error.message
        }
      });
      return;
    }

    res.status(getStatusCode(error)).json({
      error: {
        code: "v2_video_trim_review_failed",
        message: getErrorMessage(error, "V2 生成视频裁剪评审失败")
      }
    });
  }
});

v2Routes.get("/generation/trimmed-videos/:filename", (req, res) => {
  const videoPath = findV2GeneratedVideoReviewFile(req.params.filename);

  if (!videoPath) {
    res.status(404).json({
      error: {
        code: "trimmed_video_not_found",
        message: "Trimmed generated video not found"
      }
    });
    return;
  }

  res.sendFile(videoPath);
});

v2Routes.get("/generation/video-tasks/:taskId", async (req, res) => {
  try {
    const result = await getV2VideoGenerationTask(req.params.taskId);
    res.json(result);
  } catch (error) {
    if (error instanceof V2PipelineInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_v2_video_task_input",
          message: error.message
        }
      });
      return;
    }

    res.status(getStatusCode(error)).json({
      error: {
        code: "v2_video_task_query_failed",
        message: getErrorMessage(error, "V2 视频生成任务查询失败")
      }
    });
  }
});
