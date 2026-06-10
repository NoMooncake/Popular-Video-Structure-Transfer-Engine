import path from "node:path";

import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";

import {
  findUploadedVideoById,
  formatUploadResponse,
  UploadValidationError,
  videoUploadMiddleware
} from "../services/uploadService.js";

export const uploadRoutes = Router();

const handleUploadError = (
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

uploadRoutes.post(
  "/videos",
  videoUploadMiddleware.array("files", 10),
  (req: Request, res: Response) => {
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

    res.status(201).json(formatUploadResponse(files));
  },
  handleUploadError
);

uploadRoutes.post(
  "/video",
  videoUploadMiddleware.single("file"),
  (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({
        error: {
          code: "missing_file",
          message: "Upload one video file using the file field"
        }
      });
      return;
    }

    res.status(201).json(formatUploadResponse([req.file]));
  },
  handleUploadError
);

uploadRoutes.get("/files/:fileId", (req, res) => {
  const filePath = findUploadedVideoById(req.params.fileId);

  if (!filePath) {
    res.status(404).json({
      error: {
        code: "file_not_found",
        message: "Uploaded file not found"
      }
    });
    return;
  }

  res.sendFile(filePath, {
    headers: {
      "Content-Disposition": `inline; filename="${path.basename(filePath)}"`
    }
  });
});
