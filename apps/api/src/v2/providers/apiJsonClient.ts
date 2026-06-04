import { config } from "../../config/index.js";
import fs from "node:fs";
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

type ChatContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "video_url";
      video_url: {
        url: string;
      };
      fps: number;
      media_resolution: "default" | "max";
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

const isVideoReference = (value: string): boolean => {
  return /\.(mp4|mov|avi|wmv)(?:[?#].*)?$/iu.test(value);
};

const getMimeType = (value: string): string => {
  const lowerValue = value.toLowerCase();

  if (lowerValue.endsWith(".mov")) {
    return "video/quicktime";
  }

  if (lowerValue.endsWith(".avi")) {
    return "video/x-msvideo";
  }

  if (lowerValue.endsWith(".wmv")) {
    return "video/x-ms-wmv";
  }

  return "video/mp4";
};

const toVideoUrl = (value: string): string | undefined => {
  if (value.startsWith("data:video/")) {
    return value;
  }

  if (/^https?:\/\//iu.test(value) && isVideoReference(value)) {
    return value;
  }

  if (!value.startsWith("/") || !isVideoReference(value) || !fs.existsSync(value)) {
    return undefined;
  }

  const maxRawBytesForBase64Limit = 37 * 1024 * 1024;
  const stats = fs.statSync(value);

  if (!stats.isFile() || stats.size > maxRawBytesForBase64Limit) {
    return undefined;
  }

  const encodedVideo = fs.readFileSync(value).toString("base64");
  return `data:${getMimeType(value)};base64,${encodedVideo}`;
};

const collectVideoContentParts = (value: unknown): ChatContentPart[] => {
  const parts: ChatContentPart[] = [];
  const visit = (currentValue: unknown): void => {
    if (Array.isArray(currentValue)) {
      for (const item of currentValue) {
        visit(item);
      }
      return;
    }

    if (!currentValue || typeof currentValue !== "object") {
      return;
    }

    const record = currentValue as Record<string, unknown>;
    const uri = typeof record.uri === "string" ? record.uri : undefined;
    const url = typeof record.url === "string" ? record.url : undefined;
    const videoUrl = uri ? toVideoUrl(uri) : url ? toVideoUrl(url) : undefined;

    if (videoUrl) {
      parts.push({
        type: "video_url",
        video_url: {
          url: videoUrl
        },
        fps: 2,
        media_resolution: "default"
      });
    }

    for (const nestedValue of Object.values(record)) {
      visit(nestedValue);
    }
  };

  visit(value);
  return parts;
};

const sanitizeMediaReferences = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMediaReferences(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => {
      if (
        (key === "uri" || key === "url") &&
        typeof nestedValue === "string" &&
        (nestedValue.startsWith("data:video/") ||
          (nestedValue.startsWith("/") && isVideoReference(nestedValue)))
      ) {
        return [key, "[attached_video]"];
      }

      return [key, sanitizeMediaReferences(nestedValue)];
    })
  );
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
  const mediaParts = collectVideoContentParts(payload);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: systemPrompt
    },
    {
      role: "user",
      content: [
        ...mediaParts,
        {
          type: "text",
          text: JSON.stringify(
            {
              task,
              payload: sanitizeMediaReferences(payload),
              attached_video_count: mediaParts.length,
              output_format:
                "只返回一个合法 JSON object。字段名可以是英文 snake_case；所有面向用户阅读的字段值、说明、文案、图片生成 prompt、图生视频 prompt 必须使用简体中文。"
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
    messages,
    max_completion_tokens: 4096,
    max_tokens: 4096
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
