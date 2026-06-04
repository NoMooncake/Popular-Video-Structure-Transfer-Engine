import { Router } from "express";

import { config } from "../config/index.js";
import { devRoutes } from "./dev.routes.js";
import { frameRoutes } from "./frame.routes.js";
import { gapRoutes } from "./gap.routes.js";
import { generateRoutes } from "./generate.routes.js";
import { healthRoutes } from "./health.routes.js";
import { materialRoutes } from "./material.routes.js";
import { migrationRoutes } from "./migration.routes.js";
import { pipelineRoutes } from "./pipeline.routes.js";
import { sampleRoutes } from "./sample.routes.js";
import { structureRoutes } from "./structure.routes.js";
import { uploadRoutes } from "./upload.routes.js";
import { v2Routes } from "./v2.routes.js";

export const apiRoutes = Router();

apiRoutes.use("/health", healthRoutes);
apiRoutes.use("/upload", uploadRoutes);
apiRoutes.use("/frames", frameRoutes);
apiRoutes.use("/sample", sampleRoutes);
apiRoutes.use("/structure", structureRoutes);
apiRoutes.use("/structure", migrationRoutes);
apiRoutes.use("/material", materialRoutes);
apiRoutes.use("/gap", gapRoutes);
apiRoutes.use("/generate", generateRoutes);
apiRoutes.use("/pipeline", pipelineRoutes);
apiRoutes.use("/v2", v2Routes);

if (config.nodeEnv !== "production") {
  apiRoutes.use("/dev", devRoutes);
}
