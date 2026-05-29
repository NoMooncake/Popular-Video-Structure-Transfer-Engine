import { Router } from "express";

import { config } from "../config/index.js";

export const healthRoutes = Router();

healthRoutes.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "popular-video-structure-transfer-api",
    environment: config.nodeEnv,
    uptime_seconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});
