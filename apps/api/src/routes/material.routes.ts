import { Router } from "express";

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
