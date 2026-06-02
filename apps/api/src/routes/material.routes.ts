import { Router } from "express";

import {
  analyzeMaterialInput,
  MaterialAnalysisInputError
} from "../services/materialAnalysisService.js";
import {
  createMaterialInput,
  MaterialInputValidationError
} from "../services/materialInputService.js";

export const materialRoutes = Router();

materialRoutes.post("/input", (req, res) => {
  try {
    const materialInput = createMaterialInput(req.body ?? {});
    res.status(201).json(materialInput);
  } catch (error) {
    if (error instanceof MaterialInputValidationError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_material_input",
          message: error.message
        }
      });
      return;
    }

    res.status(500).json({
      error: {
        code: "material_input_failed",
        message:
          error instanceof Error
            ? error.message
            : "Failed to create material input"
      }
    });
  }
});

materialRoutes.post("/analyze", (req, res) => {
  try {
    const materialAnalysis = analyzeMaterialInput(req.body ?? {});
    res.json(materialAnalysis);
  } catch (error) {
    if (error instanceof MaterialAnalysisInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_material_analysis_input",
          message: error.message
        }
      });
      return;
    }

    const statusCode =
      error instanceof Error && "statusCode" in error
        ? Number(error.statusCode)
        : 500;

    res.status(Number.isFinite(statusCode) ? statusCode : 500).json({
      error: {
        code: "material_analysis_failed",
        message:
          error instanceof Error
            ? error.message
            : "Failed to analyze material input"
      }
    });
  }
});
