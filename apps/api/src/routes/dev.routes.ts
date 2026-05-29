import { Router } from "express";

import { parseVideoMetadata } from "../services/videoParserService.js";
import { findUploadedVideoById } from "../services/uploadService.js";
import {
  getAvailableSchemaNames,
  validateSchema,
  type SchemaName
} from "../utils/schemaValidator.js";

export const devRoutes = Router();

devRoutes.get("/schemas", (_req, res) => {
  res.json({
    schemas: getAvailableSchemaNames()
  });
});

devRoutes.post("/validate/:schemaName", (req, res, next) => {
  try {
    const schemaName = req.params.schemaName as SchemaName;
    const result = validateSchema(schemaName, req.body);

    if (!result.valid) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

devRoutes.get("/video-metadata/:fileId", async (req, res, next) => {
  try {
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

    const metadata = await parseVideoMetadata(filePath);
    res.json({
      file_id: req.params.fileId,
      video: metadata
    });
  } catch (error) {
    const statusCode =
      error instanceof Error && "statusCode" in error
        ? Number(error.statusCode)
        : 500;
    const message =
      error instanceof Error ? error.message : "Failed to parse video metadata";

    res.status(Number.isFinite(statusCode) ? statusCode : 500).json({
      error: {
        code: "video_metadata_parse_failed",
        message
      }
    });
  }
});
