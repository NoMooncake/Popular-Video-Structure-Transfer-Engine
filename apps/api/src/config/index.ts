import { env } from "./env.js";

export const config = {
  nodeEnv: env.nodeEnv,
  port: env.port,
  storage: {
    uploadDir: env.uploadDir,
    outputDir: env.outputDir,
    maxUploadFileSizeMb: env.maxUploadFileSizeMb
  },
  providers: {
    llm: {
      provider: env.llmProvider,
      model: env.llmModel,
      apiBaseUrl: env.llmApiBaseUrl,
      endpointId: env.llmEndpointId,
      apiKey: env.llmApiKey,
      enabled: Boolean(env.llmApiKey && env.llmEndpointId)
    },
    hasLlmApiKey: Boolean(env.llmApiKey),
    hasSeedanceApiKey: Boolean(env.seedanceApiKey),
    hasAigcImageApiKey: Boolean(env.aigcImageApiKey),
    hasAigcVideoApiKey: Boolean(env.aigcVideoApiKey)
  }
} as const;
