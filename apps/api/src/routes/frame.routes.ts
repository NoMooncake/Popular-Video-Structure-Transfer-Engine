import { Router } from "express";

import { findExtractedFrame } from "../services/frameExtractService.js";

export const frameRoutes = Router();

frameRoutes.get("/:fileId/:filename", (req, res) => {
  const framePath = findExtractedFrame(req.params.fileId, req.params.filename);

  if (!framePath) {
    res.status(404).json({
      error: {
        code: "frame_not_found",
        message: "Extracted frame not found"
      }
    });
    return;
  }

  res.sendFile(framePath);
});
