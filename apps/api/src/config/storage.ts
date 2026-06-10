import path from "node:path";

import { config } from "./index.js";

const repoRoot = path.resolve(process.cwd(), "../..");

const resolveStoragePath = (configuredPath: string): string => {
  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }

  return path.resolve(repoRoot, configuredPath);
};

export const storageConfig = {
  uploadDir: resolveStoragePath(config.storage.uploadDir),
  outputDir: resolveStoragePath(config.storage.outputDir),
  maxUploadFileSizeBytes: config.storage.maxUploadFileSizeMb * 1024 * 1024,
  allowedVideoMimeTypes: [
    "video/mp4",
    "video/quicktime",
    "video/webm"
  ] as readonly string[],
  allowedVideoExtensions: [
    ".mp4",
    ".mov",
    ".webm"
  ] as readonly string[]
} as const;
