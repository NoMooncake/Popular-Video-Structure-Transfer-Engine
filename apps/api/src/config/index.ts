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
    hasAigcVideoApiKey: Boolean(env.aigcVideoApiKey),
    v2: {
      multimodal: {
        provider: env.v2MultimodalProvider,
        apiBaseUrl: env.v2MultimodalApiBaseUrl,
        apiPath: env.v2MultimodalApiPath,
        model: env.v2MultimodalModel,
        apiKey: env.v2MultimodalApiKey,
        enabled: Boolean(
          env.v2MultimodalApiBaseUrl &&
            env.v2MultimodalModel &&
            env.v2MultimodalApiKey
        )
      },
      image: {
        provider: env.v2ImageProvider,
        apiBaseUrl: env.v2ImageApiBaseUrl,
        apiPath: env.v2ImageApiPath,
        model: env.v2ImageModel,
        apiKey: env.v2ImageApiKey,
        enabled: Boolean(
          env.v2ImageApiBaseUrl && env.v2ImageModel && env.v2ImageApiKey
        )
      },
      video: {
        provider: env.v2VideoProvider,
        apiBaseUrl: env.v2VideoApiBaseUrl,
        apiPath: env.v2VideoApiPath,
        model: env.v2VideoModel,
        apiKey: env.v2VideoApiKey,
        enabled: Boolean(
          env.v2VideoApiBaseUrl && env.v2VideoModel && env.v2VideoApiKey
        )
      }
    }
  }
} as const;
