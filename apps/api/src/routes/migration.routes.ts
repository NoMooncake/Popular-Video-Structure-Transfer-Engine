import { Router } from "express";

import {
  migrateStructureToMaterials,
  StructureMigrationInputError
} from "../services/structureMigrationService.js";

export const migrationRoutes = Router();

migrationRoutes.post("/migrate", (req, res) => {
  try {
    const slotMapping = migrateStructureToMaterials(req.body ?? {});
    res.json(slotMapping);
  } catch (error) {
    if (error instanceof StructureMigrationInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_structure_migration_input",
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
        code: "structure_migration_failed",
        message:
          error instanceof Error
            ? error.message
            : "Failed to migrate structure to materials"
      }
    });
  }
});
