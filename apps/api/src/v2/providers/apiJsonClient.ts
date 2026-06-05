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

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : undefined;
};

const asObject = (value: unknown): JsonObject => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
};

const firstObjectFromArray = (value: unknown): JsonObject => {
  return Array.isArray(value) ? asObject(value[0]) : {};
};

const extractImagePrompt = (promptPackage: JsonObject): string => {
  const directPrompt =
    normalizeOptionalString(promptPackage.prompt) ||
    normalizeOptionalString(promptPackage.image_prompt);

  if (directPrompt) {
    return directPrompt;
  }

  const candidates = [
    firstObjectFromArray(promptPackage.image_prompt_candidates),
    firstObjectFromArray(promptPackage.image_prompts),
    firstObjectFromArray(promptPackage.image_generation_prompts),
    firstObjectFromArray(asObject(promptPackage.generation_prompt_package).image_prompt_candidates),
    firstObjectFromArray(
      asObject(promptPackage.generation_prompts_for_insufficient_slots).image_prompts
    ),
    firstObjectFromArray(
      asObject(promptPackage.missing_material_prompts).image_generation_prompts
    ),
    firstObjectFromArray(
      asObject(promptPackage.aigc_generation_plan).picture_generation_prompts
    )
  ];

  for (const candidate of candidates) {
    const prompt =
      normalizeOptionalString(candidate.prompt) ||
      normalizeOptionalString(candidate.image_prompt) ||
      normalizeOptionalString(candidate["图片生成提示词"]);

    if (prompt) {
      return prompt;
    }
  }

  throw new V2ProviderExecutionError("未找到可用于生图的 prompt");
};

const candidateDiversityInstructions = [
  "候选图 1：标准商品定版。构图更稳，产品主体完整清晰，适合直接做广告主视觉卡片。",
  "候选图 2：动感冲击版本。镜头角度更有张力，视觉动势、材质高光、动作瞬间或场景能量更强，适合强调产品带来的核心感受。",
  "候选图 3：高级留白版本。背景更简洁，CTA 文字预留空间更大，光线更干净，适合后续叠加按钮、优惠或口号。",
  "候选图 4：近景质感版本。镜头更靠近产品或关键使用细节，突出材质、纹理、包装、质地、光泽、触感或工艺感。",
  "候选图 5：场景氛围版本。保留同一产品主体，但背景加入更明确的使用场景、目标人群或生活方式暗示，仍然不能改变产品设定。",
  "候选图 6：强包装版本。产品包装、品牌视觉和可识别元素更突出，适合前端卡片里作为更商业化的选择。"
] as const;

const withImageCandidateInstruction = (
  prompt: string,
  count: number,
  candidateIndex?: number
): string => {
  const candidateInstruction =
    candidateIndex === undefined
      ? undefined
      : candidateDiversityInstructions[
          candidateIndex % candidateDiversityInstructions.length
        ];

  return [
    prompt,
    "",
    "【高优先级生成规则】以下规则优先级高于上方 prompt 中的举例和负面约束。",
    count > 1
      ? `请基于以上同一个广告槽位生成 ${count} 张候选图，供用户选择。`
      : "请基于以上广告槽位生成 1 张候选图，供用户确认。",
    candidateInstruction
      ? `【本次只生成其中 1 张】${candidateInstruction}`
      : undefined,
    "多张候选图必须围绕同一个具体主题、同一个产品设定、同一个广告槽位和同一个视觉任务生成；只允许在构图、光线、景别、背景细节、镜头角度或视觉冲击点上变化。",
    "不要把 prompt 里的多个示例、多个物体、多个场景分别生成成不同主题的候选图；如果 prompt 中列出多个例子，请选最符合用户素材和产品的一种作为统一主题。",
    "如果请求中包含参考图片，请把这些图片作为用户素材的强参考，而不是普通风格参考；必须优先保持其中的产品、人物主角、包装、场景、构图关系和色调质感。",
    "如果参考图片里有明确产品，即使原 prompt 写了“不要出现完整产品”或类似限制，也要理解为“不要出现无关产品或无关品牌”，不能删除参考图里的核心产品。",
    "如果参考图片里有人物，即使原 prompt 写了“不要出现人物”或类似限制，也要理解为“不要新增无关人物”，不能删除参考图里的主角人物；人物相关画面要尽量保持年龄感、发型、穿着风格、气质和场景关系。",
    "如果参考图片里没有人物，非必要画面不要凭空新增人物。",
    "不要改变产品核心设定，不要加入无关品牌，不要把候选图做成重复画面。"
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
};

const withVolcengineVideoPromptOptions = (
  prompt: string,
  durationSeconds: number,
  cameraFixed: boolean,
  watermark: boolean
): string => {
  const boundedDuration = Math.max(1, Math.min(30, Math.round(durationSeconds)));
  const hasDurationFlag = /--duration\s+\d+/iu.test(prompt);
  const hasCameraFixedFlag = /--camerafixed\s+(?:true|false)/iu.test(prompt);
  const hasWatermarkFlag = /--watermark\s+(?:true|false)/iu.test(prompt);
  const optionParts = [
    hasDurationFlag ? undefined : `--duration ${boundedDuration}`,
    hasCameraFixedFlag ? undefined : `--camerafixed ${cameraFixed ? "true" : "false"}`,
    hasWatermarkFlag ? undefined : `--watermark ${watermark ? "true" : "false"}`
  ].filter((part): part is string => Boolean(part));

  return optionParts.length > 0 ? `${prompt}  ${optionParts.join(" ")}` : prompt;
};

const normalizeBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (/^(true|1|yes)$/iu.test(value)) {
      return true;
    }

    if (/^(false|0|no)$/iu.test(value)) {
      return false;
    }
  }

  return fallback;
};

const requestJson = async (
  providerConfig: ApiProviderConfig,
  body: JsonObject
): Promise<JsonObject> => {
  return requestProviderJson(providerConfig, providerConfig.apiPath, "POST", body);
};

const requestProviderJson = async (
  providerConfig: ApiProviderConfig,
  apiPath: string,
  method: "GET" | "POST",
  body?: JsonObject
): Promise<JsonObject> => {
  assertConfigured(providerConfig);

  const url = joinUrl(providerConfig.apiBaseUrl!, apiPath);
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${providerConfig.apiKey}`,
      "Content-Type": "application/json"
    },
    body: method === "POST" ? JSON.stringify(body || {}) : undefined,
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
  count: number,
  referenceImages: string[] = []
): Promise<JsonObject> => {
  const providerConfig = config.providers.v2.image;
  const basePrompt = extractImagePrompt(promptPackage);
  const normalizedReferenceImages = referenceImages.filter((image) =>
    /^data:image\/|^https?:\/\//iu.test(image)
  );
  const referenceImageBody =
    normalizedReferenceImages.length > 0
      ? {
          image:
            normalizedReferenceImages.length === 1
              ? normalizedReferenceImages[0]
              : normalizedReferenceImages
        }
      : {};

  const makeRequestBody = (prompt: string): JsonObject => ({
    model: providerConfig.model,
    prompt,
    size: "2K",
    output_format: "png",
    response_format: "url",
    watermark: true,
    ...referenceImageBody
  });

  if (count <= 1) {
    return requestJson(
      providerConfig,
      makeRequestBody(withImageCandidateInstruction(basePrompt, count))
    );
  }

  const responses = await Promise.all(
    Array.from({ length: count }, (_value, index) =>
      requestJson(
        providerConfig,
        makeRequestBody(withImageCandidateInstruction(basePrompt, count, index))
      )
    )
  );
  const data = responses.flatMap((response) =>
    Array.isArray(response.data) ? response.data : [response]
  );
  const usage = responses.reduce<JsonObject>((currentUsage, response) => {
    const responseUsage = asObject(response.usage);

    for (const field of ["generated_images", "output_tokens", "total_tokens"]) {
      const currentValue = Number(currentUsage[field] || 0);
      const nextValue = Number(responseUsage[field] || 0);

      if (Number.isFinite(nextValue)) {
        currentUsage[field] = currentValue + nextValue;
      }
    }

    return currentUsage;
  }, {});

  return {
    model: normalizeOptionalString(responses[0]?.model) || providerConfig.model,
    created: responses[0]?.created,
    candidate_generation_mode: "separate_variant_requests",
    data,
    usage
  };
};

export const requestImageToVideo = async (
  payload: JsonObject
): Promise<JsonObject> => {
  const providerConfig = config.providers.v2.video;
  const isVolcengineContentTask = /contents\/generations\/tasks/iu.test(
    providerConfig.apiPath
  );

  if (isVolcengineContentTask) {
    const prompt = normalizeOptionalString(payload.prompt);
    const imageUri =
      normalizeOptionalString(payload.image_uri) ||
      normalizeOptionalString(payload.approved_image_uri);
    const durationSeconds = Number(payload.duration_seconds || 5);
    const cameraFixed = normalizeBoolean(payload.camera_fixed ?? payload.camerafixed, false);
    const watermark = normalizeBoolean(payload.watermark, true);
    const content: JsonObject[] = [];

    if (prompt) {
      content.push({
        type: "text",
        text: withVolcengineVideoPromptOptions(
          prompt,
          Number.isFinite(durationSeconds) ? durationSeconds : 5,
          cameraFixed,
          watermark
        )
      });
    }

    if (imageUri) {
      content.push({
        type: "image_url",
        image_url: {
          url: imageUri
        }
      });
    }

    return requestProviderJson(providerConfig, providerConfig.apiPath, "POST", {
      model: providerConfig.model,
      content
    });
  }

  return requestJson(providerConfig, {
    model: providerConfig.model,
    ...payload
  });
};

export const requestVideoGenerationTask = async (
  taskId: string
): Promise<JsonObject> => {
  const providerConfig = config.providers.v2.video;
  const taskPath = `${providerConfig.apiPath.replace(/\/$/u, "")}/${encodeURIComponent(
    taskId
  )}`;

  return requestProviderJson(providerConfig, taskPath, "GET");
};
