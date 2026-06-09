import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRootEnvPath = path.resolve(__dirname, "../../../..", ".env");

dotenv.config({ path: repoRootEnvPath, override: false });

const readNumber = (name: string, fallback: number): number => {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue)) {
    throw new Error(`${name} must be a number`);
  }

  return parsedValue;
};

const readString = (name: string, fallback: string): string => {
  return process.env[name] || fallback;
};

const readOptionalString = (name: string): string | undefined => {
  return process.env[name] || undefined;
};

export const env = {
  nodeEnv: readString("NODE_ENV", "development"),
  port: readNumber("PORT", 4000),
  uploadDir: readString("UPLOAD_DIR", "uploads"),
  outputDir: readString("OUTPUT_DIR", "outputs"),
  maxUploadFileSizeMb: readNumber("MAX_UPLOAD_FILE_SIZE_MB", 200),
  llmProvider: readString("LLM_PROVIDER", "doubao"),
  llmModel: readString("LLM_MODEL", "Doubao-Seed-2.0-lite"),
  llmApiBaseUrl: readString("LLM_API_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3"),
  llmEndpointId: readOptionalString("LLM_ENDPOINT_ID"),
  llmApiKey: readOptionalString("LLM_API_KEY"),
  seedanceApiKey: readOptionalString("SEEDANCE_API_KEY"),
  arkApiKey: readOptionalString("ARK_API_KEY"),
  aigcImageApiKey: readOptionalString("AIGC_IMAGE_API_KEY"),
  aigcVideoApiKey: readOptionalString("AIGC_VIDEO_API_KEY"),
  v2MultimodalProvider: readString("V2_MULTIMODAL_PROVIDER", "xiaomi"),
  v2MultimodalApiBaseUrl: readOptionalString("V2_MULTIMODAL_API_BASE_URL"),
  v2MultimodalApiPath: readString("V2_MULTIMODAL_API_PATH", "/chat/completions"),
  v2MultimodalModel: readOptionalString("V2_MULTIMODAL_MODEL"),
  v2MultimodalApiKey: readOptionalString("V2_MULTIMODAL_API_KEY"),
  v2ProviderTimeoutMs: readNumber("V2_PROVIDER_TIMEOUT_MS", 300000),
  v2ImageProvider: readString("V2_IMAGE_PROVIDER", "seedance"),
  v2ImageApiBaseUrl: readOptionalString("V2_IMAGE_API_BASE_URL"),
  v2ImageApiPath: readString("V2_IMAGE_API_PATH", "/images/generations"),
  v2ImageModel: readOptionalString("V2_IMAGE_MODEL"),
  v2ImageApiKey: readOptionalString("V2_IMAGE_API_KEY") || readOptionalString("ARK_API_KEY"),
  v2VideoProvider: readString("V2_VIDEO_PROVIDER", "seedance"),
  v2VideoApiBaseUrl: readString("V2_VIDEO_API_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3"),
  v2VideoApiPath: readString("V2_VIDEO_API_PATH", "/contents/generations/tasks"),
  v2VideoModel: readOptionalString("V2_VIDEO_MODEL"),
  v2VideoApiKey: readOptionalString("V2_VIDEO_API_KEY") || readOptionalString("ARK_API_KEY")
} as const;
