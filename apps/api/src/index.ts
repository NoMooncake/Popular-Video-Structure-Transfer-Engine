import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";

import { config } from "./config/index.js";
import { apiRoutes } from "./routes/index.js";

export const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req: Request, res: Response) => {
  res.json({
    service: "popular-video-structure-transfer-api",
    status: "ok",
    docs: "/api/health"
  });
});

app.use("/api", apiRoutes);

app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: {
      code: "not_found",
      message: "Route not found"
    }
  });
});

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  res.status(500).json({
    error: {
      code: "internal_server_error",
      message: "Unexpected server error"
    }
  });
});

const server = app.listen(config.port, () => {
  console.log(`API server listening on http://localhost:${config.port}`);
});

const shutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
