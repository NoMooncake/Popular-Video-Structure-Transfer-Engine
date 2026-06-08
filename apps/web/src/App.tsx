import { useEffect, useMemo, useState } from "react";

import { AppShell } from "./components/AppShell";
import { WorkspaceViews } from "./components/WorkspaceViews";
import { canvasBlocks as fallbackCanvasBlocks, createCanvasBlocks } from "./data/workflow";
import type {
  CanvasBlock,
  SampleAnalysis,
  StepKey,
  StructureBlueprint,
  UploadedVideoFile
} from "./types";

export type WorkflowRunResult = {
  materialFiles: UploadedVideoFile[];
  sampleAnalysis: SampleAnalysis;
  sampleFile: UploadedVideoFile;
  structureBlueprint: StructureBlueprint;
};

export const App = () => {
  const [activeStep, setActiveStep] = useState<StepKey>("input");
  const [selectedBlockId, setSelectedBlockId] = useState(fallbackCanvasBlocks[0]?.id ?? "");
  const [workflowResult, setWorkflowResult] = useState<WorkflowRunResult | null>(null);
  const [blocks, setBlocks] = useState<CanvasBlock[]>(fallbackCanvasBlocks);
  const [projectName, setProjectName] = useState("未命名项目 01");

  useEffect(() => {
    if (workflowResult?.structureBlueprint) {
      setBlocks(createCanvasBlocks(workflowResult.structureBlueprint));
    }
  }, [workflowResult]);

  useEffect(() => {
    if (!blocks.some((block) => block.id === selectedBlockId)) {
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

  return (
    <AppShell>
      <main className={`workspace page-${activeStep}`}>
        <WorkspaceViews
          activeStep={activeStep}
          blocks={blocks}
          materialFiles={workflowResult?.materialFiles ?? []}
          onSelectBlock={setSelectedBlockId}
          onUpdateBlock={handleUpdateBlock}
          onStepChange={setActiveStep}
          onWorkflowReady={setWorkflowResult}
          sampleAnalysis={workflowResult?.sampleAnalysis}
          sampleFile={workflowResult?.sampleFile}
          selectedBlock={selectedBlock}
          selectedBlockId={selectedBlockId}
          structureBlueprint={workflowResult?.structureBlueprint}
          projectName={projectName}
          onProjectNameChange={setProjectName}
        />
      </main>
    </AppShell>
  );
};
