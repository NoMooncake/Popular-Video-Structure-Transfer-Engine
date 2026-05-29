import { env } from "./env.js";

export const config = {
  nodeEnv: env.nodeEnv,
  port: env.port,
  storage: {
    uploadDir: env.uploadDir,
    outputDir: env.outputDir
  },
  providers: {
    hasLlmApiKey: Boolean(env.llmApiKey),
    hasSeedanceApiKey: Boolean(env.seedanceApiKey),
    hasAigcImageApiKey: Boolean(env.aigcImageApiKey),
    hasAigcVideoApiKey: Boolean(env.aigcVideoApiKey)
  }
} as const;
