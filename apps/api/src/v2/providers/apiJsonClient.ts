import { config } from "../../config/index.js";
import type { JsonObject } from "../types.js";

type ApiProviderConfig = {
  provider: string;
  apiBaseUrl?: string;
  apiPath: string;
  model?: string;
  apiKey?: string;
  enabled: boolean;
};

type ChatMessage = {
  role: "system" | "user";
  content: unknown;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | JsonObject;
    };
  }>;
  error?: {
    message?: string;
  };
};

export class V2ProviderConfigError extends Error {
  statusCode = 503;

  constructor(provider: string) {
    super(`${provider} provider is not configured`);
    this.name = "V2ProviderConfigError";
  }
}

export class V2ProviderExecutionError extends Error {
  statusCode = 502;

  constructor(message: string) {
    super(message);
    this.name = "V2ProviderExecutionError";
  }
}

const sanitizeProviderMessage = (message: string): string => {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gu, "Bearer [redacted]")
    .replace(/api[_-]?key["':=\s]+[A-Za-z0-9._-]+/giu, "api_key [redacted]")
    .replace(/Request id:\s*[a-zA-Z0-9-]+/gu, "Request id: [redacted]")
    .replace(/request id:\s*[a-zA-Z0-9-]+/gu, "request id: [redacted]");
};

const joinUrl = (baseUrl: string, apiPath: string): string => {
  return `${baseUrl.replace(/\/$/u, "")}/${apiPath.replace(/^\//u, "")}`;
};

const assertConfigured = (providerConfig: ApiProviderConfig): void => {
  if (
    !providerConfig.enabled ||
    !providerConfig.apiBaseUrl ||
    !providerConfig.model ||
    !providerConfig.apiKey
  ) {
    throw new V2ProviderConfigError(providerConfig.provider);
  }
};

const extractJsonObject = (content: string | JsonObject | undefined): JsonObject => {
  if (!content) {
    throw new V2ProviderExecutionError("Provider response did not contain content");
  }

  if (typeof content !== "string") {
    return content;
  }

  const fencedJson = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/u);
  const rawJson = fencedJson?.[1] || content;
  const startIndex = rawJson.indexOf("{");
  const endIndex = rawJson.lastIndexOf("}");

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new V2ProviderExecutionError("Provider response did not contain a JSON object");
  }

  try {
    return JSON.parse(rawJson.slice(startIndex, endIndex + 1)) as JsonObject;
  } catch {
    throw new V2ProviderExecutionError("Provider response contained invalid JSON");
  }
};

const requestJson = async (
  providerConfig: ApiProviderConfig,
  body: JsonObject
): Promise<JsonObject> => {
  assertConfigured(providerConfig);

  const url = joinUrl(providerConfig.apiBaseUrl!, providerConfig.apiPath);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${providerConfig.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000)
  });
  const responseBody = (await response.json().catch(() => ({}))) as
    | ChatCompletionResponse
    | JsonObject;

  if (!response.ok) {
    const message =
      "error" in responseBody &&
      responseBody.error &&
      typeof responseBody.error === "object" &&
      "message" in responseBody.error
        ? String(responseBody.error.message)
        : JSON.stringify(responseBody);

    throw new V2ProviderExecutionError(
      sanitizeProviderMessage(
        `${providerConfig.provider} returned ${response.status}: ${message}`
      )
    );
  }

  return responseBody as JsonObject;
};

export const requestMultimodalJson = async (
  task: string,
  systemPrompt: string,
  payload: JsonObject
): Promise<JsonObject> => {
  const providerConfig = config.providers.v2.multimodal;
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: systemPrompt
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              task,
              payload,
              output_format: "Return only one valid JSON object."
            },
            null,
            2
          )
        }
      ]
    }
  ];

  const responseBody = (await requestJson(providerConfig, {
    model: providerConfig.model,
    response_format: {
      type: "json_object"
    },
    messages
  })) as ChatCompletionResponse;

  return extractJsonObject(responseBody.choices?.[0]?.message?.content);
};

export const requestImageCandidates = async (
  promptPackage: JsonObject,
  count: number
): Promise<JsonObject> => {
  const providerConfig = config.providers.v2.image;

  return requestJson(providerConfig, {
    model: providerConfig.model,
    prompt_package: promptPackage,
    n: count
  });
};

export const requestImageToVideo = async (
  payload: JsonObject
): Promise<JsonObject> => {
  const providerConfig = config.providers.v2.video;

  return requestJson(providerConfig, {
    model: providerConfig.model,
    ...payload
  });
};
