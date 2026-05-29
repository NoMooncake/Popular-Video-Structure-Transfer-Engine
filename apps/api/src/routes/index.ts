import { Router } from "express";

import { config } from "../config/index.js";
import { devRoutes } from "./dev.routes.js";
import { healthRoutes } from "./health.routes.js";

export const apiRoutes = Router();

apiRoutes.use("/health", healthRoutes);

if (config.nodeEnv !== "production") {
  apiRoutes.use("/dev", devRoutes);
}
