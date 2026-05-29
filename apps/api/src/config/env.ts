import dotenv from "dotenv";

dotenv.config();

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
  llmApiKey: readOptionalString("LLM_API_KEY"),
  seedanceApiKey: readOptionalString("SEEDANCE_API_KEY"),
  aigcImageApiKey: readOptionalString("AIGC_IMAGE_API_KEY"),
  aigcVideoApiKey: readOptionalString("AIGC_VIDEO_API_KEY")
} as const;
