import { Router } from "express";

import {
  extractStructureBlueprint,
  StructureExtractionInputError
} from "../services/structureExtractService.js";
import type { SampleAnalysis } from "../services/sampleAnalyzeService.js";

export const structureRoutes = Router();

structureRoutes.post("/extract", async (req, res) => {
  const sampleAnalysis = (req.body?.sample_analysis ||
    req.body?.sampleAnalysis) as SampleAnalysis | undefined;
  const sampleAnalyses = (req.body?.sample_analyses ||
    req.body?.sampleAnalyses) as SampleAnalysis[] | undefined;

  try {
    const blueprint = await extractStructureBlueprint({
      sampleAnalysis,
      sampleAnalyses,
      vertical: req.body?.vertical,
      category: req.body?.category,
      useMock: req.body?.use_mock === true || req.body?.useMock === true
    });

    res.json(blueprint);
  } catch (error) {
    if (error instanceof StructureExtractionInputError) {
      res.status(error.statusCode).json({
        error: {
          code: "invalid_structure_extract_input",
          message: error.message
        }
      });
      return;
    }

    const statusCode =
      error instanceof Error && "statusCode" in error
        ? Number(error.statusCode)
        : 500;
    const message =
      error instanceof Error
        ? error.message
        : "Failed to extract structure blueprint";

    res.status(Number.isFinite(statusCode) ? statusCode : 500).json({
      error: {
        code: "structure_extract_failed",
        message
      }
    });
  }
});
