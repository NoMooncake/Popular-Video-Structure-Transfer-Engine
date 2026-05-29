import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FormatsPlugin } from "ajv-formats";
import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction
} from "ajv/dist/2020.js";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaDir = path.resolve(__dirname, "../schemas");

const schemaFileByName = {
  demo_case: "demo_case.schema.json",
  gap_report: "gap_report.schema.json",
  material_analysis: "material_analysis.schema.json",
  sample_analysis: "sample_analysis.schema.json",
  structure_blueprint: "structure_blueprint.schema.json",
  timeline_plan: "timeline_plan.schema.json"
} as const;

export type SchemaName = keyof typeof schemaFileByName;

export type SchemaValidationError = {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
};

export type SchemaValidationResult =
  | {
      valid: true;
      schemaName: SchemaName;
    }
  | {
      valid: false;
      schemaName: SchemaName;
      errors: SchemaValidationError[];
    };

const ajv = new Ajv2020({
  allErrors: true,
  strict: false
});

addFormats(ajv);

const validatorCache = new Map<SchemaName, ValidateFunction>();

export const getAvailableSchemaNames = (): SchemaName[] => {
  return Object.keys(schemaFileByName) as SchemaName[];
};

const normalizeSchemaName = (rawSchemaName: string): SchemaName => {
  const normalizedName = rawSchemaName
    .replace(/\.json$/u, "")
    .replace(/\.schema$/u, "");

  if (!(normalizedName in schemaFileByName)) {
    throw new Error(
      `Unknown schema "${rawSchemaName}". Available schemas: ${getAvailableSchemaNames().join(", ")}`
    );
  }

  return normalizedName as SchemaName;
};

const loadSchema = (schemaName: SchemaName): AnySchema => {
  const schemaPath = path.join(schemaDir, schemaFileByName[schemaName]);
  return JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as AnySchema;
};

const getValidator = (schemaName: SchemaName): ValidateFunction => {
  const cachedValidator = validatorCache.get(schemaName);
  if (cachedValidator) {
    return cachedValidator;
  }

  const validator = ajv.compile(loadSchema(schemaName));
  validatorCache.set(schemaName, validator);
  return validator;
};

const formatError = (error: ErrorObject): SchemaValidationError => {
  return {
    instancePath: error.instancePath || "/",
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message || "Schema validation failed",
    params: error.params as Record<string, unknown>
  };
};

export const validateSchema = (
  rawSchemaName: string,
  data: unknown
): SchemaValidationResult => {
  const schemaName = normalizeSchemaName(rawSchemaName);
  const validator = getValidator(schemaName);
  const valid = validator(data);

  if (valid) {
    return {
      valid: true,
      schemaName
    };
  }

  return {
    valid: false,
    schemaName,
    errors: (validator.errors || []).map(formatError)
  };
};

export const assertValidSchema = (schemaName: string, data: unknown): void => {
  const result = validateSchema(schemaName, data);
  if (!result.valid) {
    throw new Error(
      `Schema validation failed for ${schemaName}: ${JSON.stringify(result.errors)}`
    );
  }
};
