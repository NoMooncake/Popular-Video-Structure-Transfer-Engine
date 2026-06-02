import type { ReactNode } from "react";

import { steps } from "../data/workflow";
import type { StepKey } from "../types";

type AppShellProps = {
  activeStep: StepKey;
  onStepChange: (step: StepKey) => void;
  children: ReactNode;
};

export const AppShell = ({ activeStep, onStepChange, children }: AppShellProps) => {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-title">迁镜</div>
          <div>
            <p>未命名画布</p>
          </div>
        </div>
        <nav className="step-nav" aria-label="工作流步骤">
          {steps.map((step, index) => (
            <button
              className={step.key === activeStep ? "step-link active" : "step-link"}
              key={step.key}
              onClick={() => onStepChange(step.key)}
              type="button"
            >
              <span className="step-index">{index + 1}</span>
              <span>
                <strong>{step.label}</strong>
                <small>{step.description}</small>
              </span>
            </button>
          ))}
        </nav>
        <div className="avatar" aria-label="用户头像">
          CY
        </div>
      </header>
      {children}
    </div>
  );
};
