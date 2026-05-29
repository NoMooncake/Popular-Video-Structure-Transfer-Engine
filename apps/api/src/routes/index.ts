import { Router } from "express";

import { config } from "../config/index.js";
import { devRoutes } from "./dev.routes.js";
import { frameRoutes } from "./frame.routes.js";
import { healthRoutes } from "./health.routes.js";
import { sampleRoutes } from "./sample.routes.js";
import { uploadRoutes } from "./upload.routes.js";

export const apiRoutes = Router();

apiRoutes.use("/health", healthRoutes);
apiRoutes.use("/upload", uploadRoutes);
apiRoutes.use("/frames", frameRoutes);
apiRoutes.use("/sample", sampleRoutes);

if (config.nodeEnv !== "production") {
  apiRoutes.use("/dev", devRoutes);
}
