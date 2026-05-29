import { Router } from "express";

import {
  getAvailableSchemaNames,
  validateSchema,
  type SchemaName
} from "../utils/schemaValidator.js";

export const devRoutes = Router();

devRoutes.get("/schemas", (_req, res) => {
  res.json({
    schemas: getAvailableSchemaNames()
  });
});

devRoutes.post("/validate/:schemaName", (req, res, next) => {
  try {
    const schemaName = req.params.schemaName as SchemaName;
    const result = validateSchema(schemaName, req.body);

    if (!result.valid) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});
