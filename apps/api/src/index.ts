import { app } from "./app.js";
import { config } from "./config/index.js";

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
