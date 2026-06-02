import crypto from "node:crypto";

export type MaterialInputSellingPoint = {
  point_id: string;
  text: string;
  priority: number;
};

export type MaterialInputFileRef = {
  file_id: string;
  path: string;
  role: "user_material";
};

export type MaterialInputTextAsset = {
  asset_id: string;
  type: "copy" | "note" | "brief" | "other";
  content: string;
};

export type MaterialInput = {
  id: string;
  version: string;
  created_at: string;
  source: {
    type: "manual";
    uploaded_file_count: number;
    text_asset_count: number;
  };
  target: {
    target_topic: string;
    target_audience?: string;
    product_name?: string;
    creative_brief?: string;
  };
  selling_points: MaterialInputSellingPoint[];
  uploaded_files: MaterialInputFileRef[];
  text_assets: MaterialInputTextAsset[];
};

type RawSellingPoint =
  | string
  | {
      text?: unknown;
      priority?: unknown;
    };

type RawTextAsset =
  | string
  | {
      type?: unknown;
      content?: unknown;
    };

export type CreateMaterialInputPayload = {
  target_topic?: unknown;
  targetTopic?: unknown;
  target_audience?: unknown;
  targetAudience?: unknown;
  product_name?: unknown;
  productName?: unknown;
  creative_brief?: unknown;
  creativeBrief?: unknown;
  selling_points?: unknown;
  sellingPoints?: unknown;
  uploaded_file_ids?: unknown;
  uploadedFileIds?: unknown;
  text_assets?: unknown;
  textAssets?: unknown;
};

export class MaterialInputValidationError extends Error {
  statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "MaterialInputValidationError";
  }
}

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeRequiredString = (
  value: unknown,
  fieldName: string
): string => {
  const normalized = normalizeOptionalString(value);

  if (!normalized) {
    throw new MaterialInputValidationError(`${fieldName} is required`);
  }

  return normalized;
};

const asArray = <T>(value: unknown): T[] => {
  if (Array.isArray(value)) {
    return value as T[];
  }

  if (value === undefined || value === null || value === "") {
    return [];
  }

  return [value as T];
};

const normalizeSellingPoints = (
  value: unknown
): MaterialInputSellingPoint[] => {
  const rawPoints = asArray<RawSellingPoint>(value);

  const sellingPoints = rawPoints
    .map((item, index): MaterialInputSellingPoint | undefined => {
      const text =
        typeof item === "string" ? item.trim() : normalizeOptionalString(item.text);

      if (!text) {
        return undefined;
      }

      const rawPriority = typeof item === "string" ? undefined : item.priority;
      const parsedPriority =
        typeof rawPriority === "number" && Number.isFinite(rawPriority)
          ? rawPriority
          : index + 1;

      return {
        point_id: `sp_${String(index + 1).padStart(2, "0")}`,
        text,
        priority: parsedPriority
      };
    })
    .filter((item): item is MaterialInputSellingPoint => Boolean(item));

  if (sellingPoints.length === 0) {
    throw new MaterialInputValidationError(
      "selling_points must include at least one item"
    );
  }

  return sellingPoints;
};

const normalizeUploadedFileIds = (value: unknown): MaterialInputFileRef[] => {
  return asArray<unknown>(value)
    .map((item) => normalizeOptionalString(item))
    .filter((fileId): fileId is string => Boolean(fileId))
    .map((fileId) => ({
      file_id: fileId,
      path: `/api/upload/files/${fileId}`,
      role: "user_material" as const
    }));
};

const normalizeTextAssetType = (
  value: unknown
): MaterialInputTextAsset["type"] => {
  if (
    value === "copy" ||
    value === "note" ||
    value === "brief" ||
    value === "other"
  ) {
    return value;
  }

  return "copy";
};

const normalizeTextAssets = (value: unknown): MaterialInputTextAsset[] => {
  return asArray<RawTextAsset>(value)
    .map((item, index): MaterialInputTextAsset | undefined => {
      const content =
        typeof item === "string"
          ? item.trim()
          : normalizeOptionalString(item.content);

      if (!content) {
        return undefined;
      }

      return {
        asset_id: `txt_${String(index + 1).padStart(2, "0")}`,
        type: typeof item === "string" ? "copy" : normalizeTextAssetType(item.type),
        content
      };
    })
    .filter((item): item is MaterialInputTextAsset => Boolean(item));
};

export const createMaterialInput = (
  payload: CreateMaterialInputPayload
): MaterialInput => {
  const targetTopic = normalizeRequiredString(
    payload.target_topic ?? payload.targetTopic,
    "target_topic"
  );
  const sellingPoints = normalizeSellingPoints(
    payload.selling_points ?? payload.sellingPoints
  );
  const uploadedFiles = normalizeUploadedFileIds(
    payload.uploaded_file_ids ?? payload.uploadedFileIds
  );
  const textAssets = normalizeTextAssets(payload.text_assets ?? payload.textAssets);

  return {
    id: `material_input_${crypto.randomUUID()}`,
    version: "0.1.0",
    created_at: new Date().toISOString(),
    source: {
      type: "manual",
      uploaded_file_count: uploadedFiles.length,
      text_asset_count: textAssets.length
    },
    target: {
      target_topic: targetTopic,
      target_audience: normalizeOptionalString(
        payload.target_audience ?? payload.targetAudience
      ),
      product_name: normalizeOptionalString(
        payload.product_name ?? payload.productName
      ),
      creative_brief: normalizeOptionalString(
        payload.creative_brief ?? payload.creativeBrief
      )
    },
    selling_points: sellingPoints,
    uploaded_files: uploadedFiles,
    text_assets: textAssets
  };
};
