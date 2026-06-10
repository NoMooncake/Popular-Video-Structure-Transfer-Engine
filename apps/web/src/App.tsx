import { useEffect, useMemo, useState } from "react";

import { AppShell } from "./components/AppShell";
import { WorkspaceViews } from "./components/WorkspaceViews";
import {
  canvasBlocks as fallbackCanvasBlocks,
  createCanvasBlocks,
  createCanvasBlocksFromV2Coverage,
  createCanvasBlocksFromV2Pipeline
} from "./data/workflow";
import type {
  CanvasBlock,
  SampleAnalysis,
  StepKey,
  StructureBlueprint,
  V2CanvasFinalVideoResult,
  V2FinalAssemblyResult,
  UploadedVideoFile,
  V2PipelineResult
} from "./types";
import type {
  V2CanvasRevalidateResult,
  V2CanvasSession,
  V2ScriptSession
} from "./api/client";

export type WorkflowRunResult = {
  canvasSessionId?: string;
  finalAssembly?: V2FinalAssemblyResult;
  finalVideo?: V2CanvasFinalVideoResult;
  materialFiles: UploadedVideoFile[];
  sampleAnalysis?: SampleAnalysis;
  sampleFile?: UploadedVideoFile;
  sampleFiles?: UploadedVideoFile[];
  canvasRevalidateResult?: V2CanvasRevalidateResult;
  canvasSession?: V2CanvasSession;
  scriptSession?: V2ScriptSession;
  structureBlueprint?: StructureBlueprint;
  v2PipelineResult?: V2PipelineResult;
};

export const App = () => {
  const [activeStep, setActiveStep] = useState<StepKey>("input");
  const [selectedBlockId, setSelectedBlockId] = useState(fallbackCanvasBlocks[0]?.id ?? "");
  const [workflowResult, setWorkflowResult] = useState<WorkflowRunResult | null>(null);
  const [blocks, setBlocks] = useState<CanvasBlock[]>(fallbackCanvasBlocks);
  const [projectName, setProjectName] = useState("未命名项目 01");

  useEffect(() => {
    if (workflowResult?.canvasRevalidateResult) {
      setBlocks(
        createCanvasBlocksFromV2Coverage(
          workflowResult.canvasRevalidateResult.material_coverage.slot_coverage,
          workflowResult.canvasRevalidateResult.canvas_session_id
        )
      );
      return;
    }

    if (workflowResult?.v2PipelineResult) {
      setBlocks(createCanvasBlocksFromV2Pipeline(workflowResult.v2PipelineResult));
      return;
    }

    if (workflowResult?.structureBlueprint) {
      setBlocks(createCanvasBlocks(workflowResult.structureBlueprint));
    }
  }, [
    workflowResult?.canvasRevalidateResult,
    workflowResult?.structureBlueprint,
    workflowResult?.v2PipelineResult
  ]);

  useEffect(() => {
    if (selectedBlockId && !blocks.some((block) => block.id === selectedBlockId)) {
      setSelectedBlockId(blocks[0]?.id ?? "");
    }
  }, [blocks, selectedBlockId]);

  const selectedBlock = useMemo(() => {
    return blocks.find((block) => block.id === selectedBlockId) ?? blocks[0] ?? fallbackCanvasBlocks[0];
  }, [blocks, selectedBlockId]);

  const handleUpdateBlock = (updatedBlock: CanvasBlock) => {
    setBlocks((prev) =>
      prev.map((block) => (block.id === updatedBlock.id ? updatedBlock : block))
    );
  };

  const handleReorderBlocks = (orderedIds: string[]) => {
    setBlocks((prev) => {
      const byId = new Map(prev.map((block) => [block.id, block]));
      const reordered = orderedIds
        .map((id) => byId.get(id))
        .filter((block): block is CanvasBlock => Boolean(block));
      // Keep any block not present in orderedIds (safety) appended at the end.
      const seen = new Set(orderedIds);
      const remainder = prev.filter((block) => !seen.has(block.id));
      return [...reordered, ...remainder];
    });
  };

  const handleWorkflowPatch = (patch: Partial<WorkflowRunResult>) => {
    setWorkflowResult((current) => (current ? { ...current, ...patch } : current));
  };

  return (
    <AppShell>
      <main className={`workspace page-${activeStep}`}>
        <WorkspaceViews
          activeStep={activeStep}
          blocks={blocks}
          materialFiles={workflowResult?.materialFiles ?? []}
          onSelectBlock={setSelectedBlockId}
          onUpdateBlock={handleUpdateBlock}
          onReorderBlocks={handleReorderBlocks}
          onStepChange={setActiveStep}
          onWorkflowPatch={handleWorkflowPatch}
          onWorkflowReady={setWorkflowResult}
          sampleAnalysis={workflowResult?.sampleAnalysis}
          sampleFile={workflowResult?.sampleFile}
          sampleFiles={workflowResult?.sampleFiles}
          canvasSession={workflowResult?.canvasSession}
          scriptSession={workflowResult?.scriptSession}
          selectedBlock={selectedBlock}
          selectedBlockId={selectedBlockId}
          structureBlueprint={workflowResult?.structureBlueprint}
          workflowResult={workflowResult}
          v2PipelineResult={workflowResult?.v2PipelineResult}
          projectName={projectName}
          onProjectNameChange={setProjectName}
        />
      </main>
    </AppShell>
  );
};
