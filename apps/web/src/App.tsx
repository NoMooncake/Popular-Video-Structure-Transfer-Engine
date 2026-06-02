import { useMemo, useState } from "react";

import { AppShell } from "./components/AppShell";
import { InspectorPanel } from "./components/InspectorPanel";
import { VideoBlockCanvas } from "./components/VideoBlockCanvas";
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
    <AppShell activeStep={activeStep} onStepChange={setActiveStep}>
      <main className="workspace">
        <header className="workspace-header">
          <div>
            <span className="eyebrow">AIGC Short Video Agent</span>
            <h1>样例驱动的视频结构迁移</h1>
          </div>
          <div className="header-actions">
            <button type="button">保存草稿</button>
            <button className="primary-button" type="button">
              导出结果
            </button>
          </div>
        </header>

        <div className="workspace-grid">
          <div className="main-column">
            <WorkspaceViews activeStep={activeStep} selectedBlock={selectedBlock} />
            {activeStep !== "input" ? (
              <VideoBlockCanvas
                blocks={canvasBlocks}
                onSelectBlock={setSelectedBlockId}
                selectedBlockId={selectedBlock.id}
              />
            ) : null}
          </div>
          <InspectorPanel block={selectedBlock} />
        </div>
      </main>
    </AppShell>
  );
};
