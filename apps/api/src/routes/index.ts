import { Router } from "express";

import { config } from "../config/index.js";
import { devRoutes } from "./dev.routes.js";
import { healthRoutes } from "./health.routes.js";
import { uploadRoutes } from "./upload.routes.js";

export const apiRoutes = Router();

apiRoutes.use("/health", healthRoutes);
apiRoutes.use("/upload", uploadRoutes);

if (config.nodeEnv !== "production") {
  apiRoutes.use("/dev", devRoutes);
}
