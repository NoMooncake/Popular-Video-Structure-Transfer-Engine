import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";

import { config } from "../config/index.js";
import {
  buildV2MaterialCandidatePool,
  findV2MaterialCandidateFrameFile,
  readV2MaterialCandidatePool
} from "../services/v2MaterialCandidatePoolService.js";
import {
  addUploadedFilesToV2ScriptSlot,
  addV2ScriptSlotMaterials,
  createV2ScriptSession,
  getV2ScriptSession,
  reorderV2ScriptSlots,
  revalidateV2CanvasFromScript,
  updateV2ScriptSlot
} from "../services/v2ScriptCanvasService.js";
import {
  assembleV2FinalVideo,
  findV2FinalAssemblyVideoFile,
  findV2GeneratedVideoReviewFile,
  generateV2ImageCandidates,
  generateV2ImageToVideo,
  getV2VideoGenerationTask,
  reviewAndTrimV2GeneratedVideo,
  runV2Pipeline,
  V2PipelineInputError
} from "../services/v2PipelineService.js";
import {
  formatUploadedVideo,
  UploadValidationError,
  videoUploadMiddleware
} from "../services/uploadService.js";

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

const handleV2UploadError = (
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  if (error instanceof UploadValidationError) {
    res.status(error.statusCode).json({
      error: {
        code: "invalid_upload",
        message: error.message
      }
    });
    return;
  }

  if (error instanceof multer.MulterError) {
    res.status(400).json({
      error: {
        code: error.code,
        message: error.message
      }
    });
    return;
  }

  next(error);
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

v2Routes.post("/script-sessions", (req, res) => {
  try {
    const result = createV2ScriptSession(req.body ?? {});
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof V2PipelineInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_v2_script_session_input",
          message: error.message
        }
      });
      return;
    }

    res.status(getStatusCode(error)).json({
      error: {
        code: "v2_script_session_failed",
        message: getErrorMessage(error, "V2 脚本会话创建失败")
      }
    });
  }
});

v2Routes.get("/script-sessions/:sessionId", (req, res) => {
  try {
    res.json(getV2ScriptSession(req.params.sessionId));
  } catch (error) {
    if (error instanceof V2PipelineInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_v2_script_session_input",
          message: error.message
        }
      });
      return;
    }

    res.status(getStatusCode(error)).json({
      error: {
        code: "v2_script_session_failed",
        message: getErrorMessage(error, "V2 脚本会话读取失败")
      }
    });
  }
});

v2Routes.patch("/script-sessions/:sessionId/slots/:slotId", (req, res) => {
  try {
    res.json(updateV2ScriptSlot(req.params.sessionId, req.params.slotId, req.body ?? {}));
  } catch (error) {
    if (error instanceof V2PipelineInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_v2_script_slot_input",
          message: error.message
        }
      });
      return;
    }

    res.status(getStatusCode(error)).json({
      error: {
        code: "v2_script_slot_update_failed",
        message: getErrorMessage(error, "V2 脚本段落更新失败")
      }
    });
  }
});

v2Routes.patch("/script-sessions/:sessionId/slot-order", (req, res) => {
  try {
    res.json(reorderV2ScriptSlots(req.params.sessionId, req.body ?? {}));
  } catch (error) {
    if (error instanceof V2PipelineInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_v2_script_slot_order_input",
          message: error.message
        }
      });
      return;
    }

    res.status(getStatusCode(error)).json({
      error: {
        code: "v2_script_slot_order_update_failed",
        message: getErrorMessage(error, "V2 脚本段落顺序更新失败")
      }
    });
  }
});

v2Routes.post("/script-sessions/:sessionId/slots/:slotId/materials", (req, res) => {
  try {
    res.status(201).json(
      addV2ScriptSlotMaterials(req.params.sessionId, req.params.slotId, req.body ?? {})
    );
  } catch (error) {
    if (error instanceof V2PipelineInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_v2_script_slot_material_input",
          message: error.message
        }
      });
      return;
    }

    res.status(getStatusCode(error)).json({
      error: {
        code: "v2_script_slot_material_add_failed",
        message: getErrorMessage(error, "V2 段落素材添加失败")
      }
    });
  }
});

v2Routes.post(
  "/script-sessions/:sessionId/slots/:slotId/materials/upload",
  videoUploadMiddleware.array("files", 10),
  (req: Request, res: Response) => {
    try {
      const files = req.files;
      if (!Array.isArray(files) || files.length === 0) {
        res.status(400).json({
          error: {
            code: "missing_files",
            message: "Upload at least one video file using the files field"
          }
        });
        return;
      }

      const uploadedFiles = files.map(formatUploadedVideo);
      const session = addUploadedFilesToV2ScriptSlot(
        req.params.sessionId,
        req.params.slotId,
        uploadedFiles
      );
      res.status(201).json({
        files: uploadedFiles,
        script_session: session
      });
    } catch (error) {
      if (error instanceof V2PipelineInputError) {
        res.status(error.statusCode).json({
          error: {
            code: "invalid_v2_script_slot_material_input",
            message: error.message
          }
        });
        return;
      }

      res.status(getStatusCode(error)).json({
        error: {
          code: "v2_script_slot_material_upload_failed",
          message: getErrorMessage(error, "V2 段落素材上传失败")
        }
      });
    }
  },
  handleV2UploadError
);

v2Routes.post("/canvas/revalidate", async (req, res) => {
  try {
    const result = await revalidateV2CanvasFromScript(req.body ?? {});
    res.json(result);
  } catch (error) {
    if (error instanceof V2PipelineInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_v2_canvas_revalidate_input",
          message: error.message
        }
      });
      return;
    }

    res.status(getStatusCode(error)).json({
      error: {
        code: "v2_canvas_revalidate_failed",
        message: getErrorMessage(error, "V2 画布素材重校验失败")
      }
    });
  }
});

v2Routes.post("/material-candidate-pools/from-script-session", async (req, res) => {
  try {
    const session =
      req.body?.script_session && typeof req.body.script_session === "object"
        ? req.body.script_session
        : getV2ScriptSession(
            String(req.body?.session_id || req.body?.script_session_id || "")
          );
    const result = await buildV2MaterialCandidatePool({
      ...req.body,
      script_session: session
    });
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof V2PipelineInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_v2_material_candidate_pool_input",
          message: error.message
        }
      });
      return;
    }

    res.status(getStatusCode(error)).json({
      error: {
        code: "v2_material_candidate_pool_failed",
        message: getErrorMessage(error, "V2 素材候选池生成失败")
      }
    });
  }
});

v2Routes.get("/material-candidate-pools/:candidatePoolId", (req, res) => {
  try {
    res.json(readV2MaterialCandidatePool(req.params.candidatePoolId));
  } catch (error) {
    if (error instanceof V2PipelineInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_v2_material_candidate_pool_input",
          message: error.message
        }
      });
      return;
    }

    res.status(getStatusCode(error)).json({
      error: {
        code: "v2_material_candidate_pool_read_failed",
        message: getErrorMessage(error, "V2 素材候选池读取失败")
      }
    });
  }
});

v2Routes.get("/material-candidate-pools/:candidatePoolId/frames/:filename", (req, res) => {
  const framePath = findV2MaterialCandidateFrameFile(
    req.params.candidatePoolId,
    req.params.filename
  );

  if (!framePath) {
    res.status(404).json({
      error: {
        code: "material_candidate_frame_not_found",
        message: "Material candidate frame not found"
      }
    });
    return;
  }

  res.sendFile(framePath);
});

v2Routes.post("/assembly/final-video", async (req, res) => {
  try {
    const result = await assembleV2FinalVideo(req.body ?? {});
    res.json(result);
  } catch (error) {
    if (error instanceof V2PipelineInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_v2_final_assembly_input",
          message: error.message
        }
      });
      return;
    }

    res.status(getStatusCode(error)).json({
      error: {
        code: "v2_final_assembly_failed",
        message: getErrorMessage(error, "V2 最终成片合成失败")
      }
    });
  }
});

v2Routes.get("/assembly/final-videos/:filename", (req, res) => {
  const videoPath = findV2FinalAssemblyVideoFile(req.params.filename);

  if (!videoPath) {
    res.status(404).json({
      error: {
        code: "final_video_not_found",
        message: "Final assembled video not found"
      }
    });
    return;
  }

  res.sendFile(videoPath);
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
