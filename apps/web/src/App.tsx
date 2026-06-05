import { useMemo, useState } from "react";

import { AppShell } from "./components/AppShell";
import { WorkspaceViews } from "./components/WorkspaceViews";
import { canvasBlocks } from "./data/workflow";
import type { StepKey } from "./types";

export const App = () => {
  const [activeStep, setActiveStep] = useState<StepKey>("input");
  const [selectedBlockId, setSelectedBlockId] = useState(canvasBlocks[0]?.id ?? "");

  const selectedBlock = useMemo(() => {
    return canvasBlocks.find((block) => block.id === selectedBlockId) ?? canvasBlocks[0];
  }, [selectedBlockId]);

  return (
    <AppShell>
      <main className={`workspace page-${activeStep}`}>
        <WorkspaceViews
          activeStep={activeStep}
          onSelectBlock={setSelectedBlockId}
          onStepChange={setActiveStep}
          selectedBlock={selectedBlock}
          selectedBlockId={selectedBlockId}
        />
      </main>
    </AppShell>
  );
};
