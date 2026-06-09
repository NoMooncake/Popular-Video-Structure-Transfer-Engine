import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";

import type { WorkflowRunResult } from "../App";
import {
  assembleV2CanvasFinalVideo,
  analyzeV2Pipeline,
  assembleV2FinalVideo,
  createV2ScriptSession,
  revalidateV2Canvas,
  reorderV2ScriptSlots,
  updateV2ScriptSlot,
  uploadMaterialFiles,
  uploadSampleVideos
} from "../api/client";
import type {
  V2CanvasSession,
  V2ScriptSession
} from "../api/client";
import {
  canvasBlocks as fallbackCanvasBlocks,
  gapReport,
  sampleAnalysis as fallbackSampleAnalysis,
  timelinePlan
} from "../data/workflow";
import type {
  CanvasBlock,
  MatchStatus,
  SampleAnalysis,
  SampleShot,
  StepKey,
  StructureBlueprint,
  V2CanvasFinalVideoResult,
  V2FinalAssemblySlot,
  V2MaterialCoverageSlot,
  UploadedVideoFile,
  V2PipelineResult,
  V2ReferenceAnalysisTable
} from "../types";
import { StatusBadge } from "./StatusBadge";
import { VideoBlockCanvas } from "./VideoBlockCanvas";

type WorkspaceViewsProps = {
  activeStep: StepKey;
  blocks: CanvasBlock[];
  materialFiles: UploadedVideoFile[];
  onSelectBlock: (blockId: string) => void;
  onUpdateBlock: (updatedBlock: CanvasBlock) => void;
  onReorderBlocks: (orderedIds: string[]) => void;
  onStepChange: (step: StepKey) => void;
  onWorkflowPatch: (patch: Partial<WorkflowRunResult>) => void;
  onWorkflowReady: (result: WorkflowRunResult) => void;
  sampleAnalysis?: SampleAnalysis;
  sampleFile?: UploadedVideoFile;
  sampleFiles?: UploadedVideoFile[];
  canvasSession?: V2CanvasSession;
  scriptSession?: V2ScriptSession;
  selectedBlock: CanvasBlock;
  selectedBlockId: string;
  structureBlueprint?: StructureBlueprint;
  workflowResult: WorkflowRunResult | null;
  v2PipelineResult?: V2PipelineResult;
  projectName: string;
  onProjectNameChange: (name: string) => void;
};

const steps: Array<{
  key: StepKey;
  label: string;
  description: string;
}> = [
  {
    key: "input",
    label: "输入",
    description: "上传样例、多条参考视频和真实素材"
  },
  {
    key: "analysis",
    label: "样例解析",
    description: "按样例视频拆结构段落"
  },
  {
    key: "migration",
    label: "结构迁移",
    description: "映射我的素材和迁移结果"
  },
  {
    key: "gap-fill",
    label: "缺口补全",
    description: "红黄绿匹配状态和补全策略"
  },
  {
    key: "demo",
    label: "演示",
    description: "时间线预览、人工编辑和导出占位"
  }
];

const slotLabelByType: Record<string, string> = {
  risk_or_pain_hook: "风险 Hook",
  pain_desire: "需求拆解",
  product_reveal: "产品露出",
  proof_comparison: "对比证明",
  decision_warning: "避坑提醒",
  cta: "行动引导"
};

const slotGoalByType: Record<string, string> = {
  risk_or_pain_hook: "用“不要盲买猫粮”的风险信息抓住新手用户注意力。",
  pain_desire: "说明挑食、软便、过敏等猫咪需求不同，不能只看热门推荐。",
  product_reveal: "按不同需求快速展示可选猫粮方向和产品卖点。",
  proof_comparison: "用横向对比或标准卡片解释推荐理由。",
  decision_warning: "加入避坑提醒，降低用户盲目囤大袋的风险。",
  cta: "引导用户在评论区补充自家猫咪情况。"
};

const gapCopyById: Record<
  string,
  {
    impact: string;
    missing: string;
  }
> = {
  gap_01: {
    missing: "缺少开头强吸引镜头",
    impact: "前 3 秒停留风险较高，需要用包装特写、警示标题或快节奏剪辑补足冲击力。"
  },
  gap_02: {
    missing: "缺少产品特写 / 多产品横向对比镜头",
    impact: "推荐理由不够直观，需要用现有产品图和成分信息生成对比卡片。"
  },
  gap_03: {
    missing: "缺少结尾 CTA 专用画面",
    impact: "结尾行动引导不够聚焦，可以复用猫咪视频并叠加底部评论引导条。"
  }
};

const fillOptionTextByType: Record<string, string> = {
  copy_or_subtitle: "生成更强的标题或字幕钩子。",
  material_reuse: "从现有素材中裁切、复用或延长可用镜头。",
  packaging: "用标题条、标签、对比卡片或转场包装补足画面。"
};

const statusTextByStatus: Record<MatchStatus, string> = {
  missing: "未成功匹配",
  partial: "部分匹配",
  matched: "已匹配"
};

const visualSourceText: Record<string, string> = {
  generated_graphic: "AI 包装补图",
  reuse: "复用素材",
  text_card: "文字卡片",
  user_material: "用户素材"
};

const sourceMarks = ["¹", "²", "³", "⁴", "⁵", "⁶"];

const readableSlot = (block: CanvasBlock) => slotLabelByType[block.slot.slot_type] ?? block.label;

const readableGoal = (block: CanvasBlock) => {
  return slotGoalByType[block.slot.slot_type] ?? block.slot.content_goal;
};

const readableGapMissing = (gapId: string, fallback: string) => {
  return gapCopyById[gapId]?.missing ?? fallback;
};

const readableGapImpact = (gapId: string, fallback: string) => {
  return gapCopyById[gapId]?.impact ?? fallback;
};

const readableFillOption = (type: string, fallback: string) => {
  return fillOptionTextByType[type] ?? fallback;
};

const readableSource = (source?: string) => {
  if (!source) {
    return "待生成";
  }

  return visualSourceText[source] ?? source;
};

const sourceReferenceMarks = (block: CanvasBlock, fallbackIndex: number) => {
  const references = block.slot.source_evidence?.length
    ? block.slot.source_evidence
    : [`sample_${fallbackIndex + 1}`];

  return references
    .slice(0, 3)
    .map((_, index) => sourceMarks[index] ?? String(index + 1))
    .join("");
};

const formatMaterialSeconds = (value: number | undefined): string | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return `${Number(value.toFixed(3))}s`;
};

type AssignedMaterial = NonNullable<V2MaterialCoverageSlot["assigned_materials"]>[number];

const getAssignedMaterialRange = (material: AssignedMaterial): string | undefined => {
  if (material.time_range) {
    return material.time_range;
  }

  const start = material.source_in_seconds ?? material.start_seconds;
  const end = material.source_out_seconds ?? material.end_seconds;
  const startText = formatMaterialSeconds(start);
  const endText = formatMaterialSeconds(end);

  if (startText && endText) {
    return `${startText} - ${endText}`;
  }

  const durationText = formatMaterialSeconds(material.matched_material_duration);
  return durationText ? `匹配 ${durationText}` : undefined;
};

const getMigrationMaterialItems = (
  block: CanvasBlock,
  fallbackFile: UploadedVideoFile | undefined,
  localMaterialNames: string[]
): Array<{ name: string; note?: string }> => {
  const assignedMaterials = block.v2?.coverageSlot?.assigned_materials ?? [];
  const assignedItems = assignedMaterials.map((material, index) => ({
    name:
      material.label ||
      material.material_id ||
      material.segment_id ||
      `匹配片段 ${index + 1}`,
    note:
      getAssignedMaterialRange(material) ||
      material.visual_description ||
      material.recommended_usage ||
      material.content_summary
  }));
  const localItems = localMaterialNames.map((name) => ({ name }));

  if (assignedItems.length > 0) {
    return [...assignedItems, ...localItems];
  }

  const fallbackItems = fallbackFile
    ? [{ name: fallbackFile.original_filename }]
    : [{ name: "空" }];

  return [...fallbackItems, ...localItems];
};

const getEditableVoiceoverText = (block: CanvasBlock): string => {
  const value = (block.timeline?.voiceover || block.copy || "").trim();
  return value === "待生成文案" ? "" : value;
};

const toBackendCategory = (value: string) => {
  if (value.includes("猫") || value.toLowerCase().includes("pet")) {
    return "pet_food";
  }

  return value.trim() || "pet_food";
};

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : "接口连接失败";
};

const getTargetDurationSeconds = (brief: string) => {
  const match = brief.match(/(\d+(?:\.\d+)?)\s*(?:秒|s)/iu);
  const duration = Number(match?.[1] ?? 20);

  return Number.isFinite(duration) && duration > 0 ? duration : 20;
};

const readTextAssets = async (files: File[]) => {
  const textFiles = files.filter(
    (file) =>
      file.type.startsWith("text/") ||
      file.name.toLowerCase().endsWith(".txt") ||
      file.name.toLowerCase().endsWith(".md")
  );

  return Promise.all(
    textFiles.map(async (file, index) => ({
      asset_id: `txt_${String(index + 1).padStart(2, "0")}`,
      type: "note" as const,
      content: await file.text()
    }))
  );
};

const parseDurationSeconds = (value: string): number | undefined => {
  const rangeMatch = value.match(
    /(\d+(?:\.\d+)?)\s*(?:-|~|–|—|到|至)\s*(\d+(?:\.\d+)?)/u
  );
  if (rangeMatch) {
    const startSeconds = Number(rangeMatch[1]);
    const endSeconds = Number(rangeMatch[2]);
    const durationSeconds = endSeconds - startSeconds;

    return durationSeconds > 0 ? Number(durationSeconds.toFixed(3)) : undefined;
  }

  const singleMatch = value.match(/(\d+(?:\.\d+)?)/u);
  const durationSeconds = Number(singleMatch?.[1]);

  return Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Number(durationSeconds.toFixed(3))
    : undefined;
};

export const WorkspaceViews = ({
  activeStep,
  blocks,
  materialFiles,
  onSelectBlock,
  onUpdateBlock,
  onReorderBlocks,
  onStepChange,
  onWorkflowPatch,
  onWorkflowReady,
  sampleAnalysis,
  sampleFile,
  sampleFiles,
  canvasSession,
  scriptSession,
  selectedBlock,
  selectedBlockId,
  structureBlueprint,
  workflowResult,
  v2PipelineResult,
  projectName,
  onProjectNameChange
}: WorkspaceViewsProps) => {
  if (activeStep === "input") {
    return (
      <InputView
        onNext={() => onStepChange("analysis")}
        onStepChange={onStepChange}
        onWorkflowReady={onWorkflowReady}
      />
    );
  }

  if (activeStep === "analysis") {
    return (
      <FigmaSampleAnalysisView
        onNext={() => onStepChange("migration")}
        onHome={() => onStepChange("input")}
        onWorkflowPatch={onWorkflowPatch}
        sampleAnalysis={sampleAnalysis}
        sampleFile={sampleFile}
        sampleFiles={sampleFiles}
        workflowResult={workflowResult}
        structureBlueprint={structureBlueprint}
        v2PipelineResult={v2PipelineResult}
        projectName={projectName}
        onProjectNameChange={onProjectNameChange}
      />
    );
  }

  if (activeStep === "migration") {
    return (
      <StructureMigrationView
        blocks={blocks}
        materialFiles={materialFiles}
        onUpdateBlock={onUpdateBlock}
        onReorderBlocks={onReorderBlocks}
        onStepChange={onStepChange}
        onHome={() => onStepChange("input")}
        onWorkflowPatch={onWorkflowPatch}
        projectName={projectName}
        onProjectNameChange={onProjectNameChange}
        scriptSession={scriptSession}
      />
    );
  }

  if (activeStep === "gap-fill") {
    return (
      <GapFillView
        blocks={blocks}
        onNext={() => onStepChange("demo")}
        onSelectBlock={onSelectBlock}
        onUpdateBlock={onUpdateBlock}
        onStepChange={onStepChange}
        onWorkflowPatch={onWorkflowPatch}
        selectedBlockId={selectedBlockId}
        canvasSession={canvasSession}
        scriptSession={scriptSession}
        projectName={projectName}
      />
    );
  }


  return (
    <DemoView
      blocks={blocks}
      onStepChange={onStepChange}
      projectName={projectName}
      workflowResult={workflowResult}
    />
  );
};

type HeaderProps = {
  actionLabel?: string;
  activeStep: StepKey;
  onNext?: () => void;
  onStepChange: (step: StepKey) => void;
  subtitle: string;
  title: string;
  projectName?: string;
};

const CanvasTopBar = ({
  actionLabel = "下一步",
  activeStep,
  onNext,
  onStepChange,
  subtitle,
  title,
  projectName
}: HeaderProps) => {
  return (
    <header className="page-header">
      <div className="header-main">
        <div className="brand-block">
          <span className="brand-mark">迁镜</span>
          <div>
            <p>{projectName ?? "AI 视频结构迁移工作台"}</p>
            <h1>{title}</h1>
          </div>
        </div>
        <div className="header-actions">
          <div className="figma-avatar" aria-hidden="true">
            C
          </div>
          {onNext ? (
            <button className="primary-action" onClick={onNext} type="button">
              {actionLabel}
            </button>
          ) : null}
        </div>
      </div>
      <p className="page-subtitle">{subtitle}</p>
      <nav className="flow-stepper" aria-label="产品流程">
        {steps.map((step, index) => (
          <button
            className={step.key === activeStep ? "step-pill active" : "step-pill"}
            key={step.key}
            onClick={() => onStepChange(step.key)}
            type="button"
          >
            <span>{index + 1}</span>
            <strong>{step.label}</strong>
            <small>{step.description}</small>
          </button>
        ))}
      </nav>
    </header>
  );
};

const InputView = ({
  onNext,
  onStepChange,
  onWorkflowReady
}: {
  onNext: () => void;
  onStepChange: (step: StepKey) => void;
  onWorkflowReady: (result: WorkflowRunResult) => void;
}) => {
  const [brief, setBrief] = useState(
    "开始一次分镜迁移：我想基于几条爆款样例，生成一条“新手养猫怎么选猫粮”的 20 秒短视频。"
  );
  const [materialFiles, setMaterialFiles] = useState<File[]>([]);
  const [pipelineError, setPipelineError] = useState("");
  const [pipelineNote, setPipelineNote] = useState("等待上传样例视频");
  const [pipelineStatus, setPipelineStatus] = useState<
    "idle" | "uploading" | "analyzing" | "extracting" | "success" | "error"
  >("idle");
  const [sampleFiles, setSampleFiles] = useState<File[]>([]);
  const [showModal, setShowModal] = useState(false);

  const isRunning = ["uploading", "analyzing", "extracting"].includes(pipelineStatus);

  const updateSampleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    setSampleFiles(Array.from(event.target.files ?? []));
    setPipelineError("");
  };

  const updateMaterialFiles = (event: ChangeEvent<HTMLInputElement>) => {
    setMaterialFiles(Array.from(event.target.files ?? []));
    setPipelineError("");
  };

  const runPipeline = async () => {
    if (isRunning) {
      return;
    }

    if (sampleFiles.length === 0) {
      setPipelineStatus("error");
      setPipelineError("请先上传至少一个样例视频。");
      setShowModal(true);
      return;
    }

    try {
      setPipelineError("");
      setPipelineStatus("uploading");
      setPipelineNote("正在上传样例视频");
      const uploadedSample = await uploadSampleVideos(sampleFiles);
      const uploadedSampleFile = uploadedSample.files[0];

      if (!uploadedSampleFile) {
        throw new Error("上传接口没有返回样例视频 file_id。");
      }

      const videoMaterialFiles = materialFiles.filter((file) => file.type.startsWith("video/"));
      const skippedMaterialCount = materialFiles.length - videoMaterialFiles.length;
      const uploadedMaterials =
        videoMaterialFiles.length > 0
          ? await uploadMaterialFiles(videoMaterialFiles)
          : { files: [] };

      setPipelineStatus("extracting");
      setPipelineNote("正在调用 Mimo 提取结构");
      const textAssets = await readTextAssets(materialFiles);
      const pipelineResult = await analyzeV2Pipeline({
        reference_file_ids: uploadedSample.files.map((file) => file.file_id),
        user_material_file_ids: uploadedMaterials.files.map((file) => file.file_id),
        text_assets: [
          {
            asset_id: "brief_01",
            type: "brief",
            content: brief
          },
          ...textAssets
        ],
        user_request: {
          goal: brief
        },
        options: {
          allow_fallback: true,
          generate_image_candidates: false,
          image_candidate_count: 4,
          target_duration_seconds: getTargetDurationSeconds(brief)
        }
      });
      const scriptSession = await createV2ScriptSession({
        pipeline_result: pipelineResult,
        user_request: {
          goal: brief
        },
        target_duration_seconds: pipelineResult.summary.target_duration_seconds
      });

      setPipelineStatus("success");
      setPipelineNote(
        skippedMaterialCount > 0
          ? `已完成分析；${skippedMaterialCount} 个非视频素材暂未上传到当前后端。`
          : "已完成真实接口分析"
      );
      onWorkflowReady({
        materialFiles: uploadedMaterials.files,
        sampleFile: uploadedSampleFile,
        sampleFiles: uploadedSample.files,
        scriptSession,
        v2PipelineResult: pipelineResult
      });
      onNext();
    } catch (error) {
      console.warn("V2 pipeline failed.", error);
      setPipelineStatus("error");
      setPipelineNote("接口连接失败");
      setPipelineError(getErrorMessage(error));
    }
  };

  return (
    <div className="page-shell input-page-redesign">
      <header className="simple-top-bar">
        <div className="brand-mark">ShotSwift</div>
        <div className="figma-avatar">F</div>
      </header>

      <main className="content-container">
        <section className="main-section">
          <div className="hero-simple">
            <h2>开始一次视频迁移</h2>
            <p>描述你想生成的视频主题、核心目的和风格参考</p>
          </div>

          <div className="prompt-box-wide">
            <textarea
              onChange={(event) => setBrief(event.target.value)}
              rows={4}
              value={brief}
              placeholder="详细描述一下今天的任务吧..."
            />
            <button aria-label="提交需求" onClick={runPipeline} type="button" className="submit-arrow-btn">
              {isRunning ? "..." : "↑"}
            </button>
          </div>

          {pipelineStatus !== "idle" && pipelineStatus !== "success" && (
             <div className={`pipeline-status ${pipelineStatus === "error" ? "status-error" : ""}`}>
               {pipelineStatus === "error" ? (
                 <div className="status-icon-error">!</div>
               ) : (
                 <span className="status-badge">{pipelineStatus}</span>
               )}
               <div className="status-content">
                 <p className="status-note">{pipelineNote}</p>
                 {pipelineError && <p className="error-text">{pipelineError}</p>}
               </div>
             </div>
          )}

          <div className="upload-section-large">
            <label className={`upload-card-large ${sampleFiles.length > 0 ? 'has-media' : ''}`}>
              <input multiple type="file" accept="video/mp4,video/quicktime,video/webm" onChange={updateSampleFiles} />
              {sampleFiles.length > 0 ? (
                <div className="materials-list">
                  {sampleFiles.map((file, i) => (
                    <div key={i} className="material-item-preview">
                       <video src={URL.createObjectURL(file)} />
                       <span className="file-name">{file.name}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="upload-placeholder">
                  <div className="icon-video">
                    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="20" height="16" x="2" y="4" rx="2" ry="2" />
                      <path d="M10 8l6 4-6 4V8z" />
                    </svg>
                  </div>
                  <strong>参考素材</strong>
                  <span>添加你想分析的样例视频</span>
                </div>
              )}
            </label>
            <label className={`upload-card-large ${materialFiles.length > 0 ? 'has-media' : ''}`}>
              <input multiple type="file" accept="image/*,video/*,.txt,.md" onChange={updateMaterialFiles} />
              {materialFiles.length > 0 ? (
                <div className="materials-list">
                  {materialFiles.map((file, i) => (
                    <div key={i} className="material-item-preview">
                       {file.type.startsWith('image/') ? (
                         <img src={URL.createObjectURL(file)} alt={file.name} />
                       ) : file.type.startsWith('video/') ? (
                         <video src={URL.createObjectURL(file)} />
                       ) : (
                         <div className="text-preview">TXT</div>
                       )}
                       <span className="file-name">{file.name}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="upload-placeholder">
                  <div className="icon-materials">
                    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <path d="M21 15l-5-5L5 21" />
                    </svg>
                  </div>
                  <strong>真实素材</strong>
                  <span>添加你的素材</span>
                </div>
              )}
            </label>
          </div>
        </section>

        <section className="canvas-section">
          <h3>画布初始</h3>
          <div className="existing-canvases-scroll">
            {figmaSampleImages.map((src, i) => (
              <div className="canvas-card" key={i}>
                <img src={src} alt="Canvas placeholder" />
                <div className="canvas-card-title">未命名项目 {i + 1}</div>
              </div>
            ))}
          </div>
        </section>
      </main>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>提示</h3>
              <button className="close-btn" onClick={() => setShowModal(false)} aria-label="关闭">×</button>
            </div>
            <div className="modal-body">
              <p>需要添加样例视频，请先上传样例视频再继续。</p>
            </div>
            <div className="modal-footer">
              <button className="primary-action" onClick={() => setShowModal(false)}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const MetricCard = ({
  label,
  value
}: {
  label: string;
  value: string;
}) => (
  <div className="metric-card">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
);

const PlaceholderBlock = ({ label }: { label: string }) => (
  <div className="media-placeholder">
    <span>{label}</span>
  </div>
);

const figmaSampleImages = [
  "https://www.figma.com/api/mcp/asset/539affc8-2d0c-423d-a2cd-d4c5dd4afa48",
  "https://www.figma.com/api/mcp/asset/7876cb39-6467-4237-90f3-50df9e43f22f",
  "https://www.figma.com/api/mcp/asset/cc685639-818d-4944-ae66-4da8004e89a4",
  "https://www.figma.com/api/mcp/asset/18570412-5901-487f-a65f-76a94db932de"
];

type SampleAnalysisRow = {
  duration: string;
  image: string;
  shotTitle: string;
  shotDescription: string;
  migrationPossibility: string;
};

const formatSeconds = (value: number) => {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}s`;
};

const formatShotRange = (shot: SampleShot) => {
  return `${formatSeconds(shot.time_range.start_seconds)} - ${formatSeconds(shot.time_range.end_seconds)}`;
};

const buildBackendSampleRows = (
  analysis: SampleAnalysis,
  blueprint?: StructureBlueprint
): SampleAnalysisRow[] => {
  return analysis.shots.map((shot, index) => {
    const keyframe = analysis.keyframes.find((item) => shot.keyframe_refs.includes(item.frame_id));
    const slot = blueprint?.slots[index];

    return {
      duration: formatShotRange(shot),
      image: keyframe?.media.uri ?? analysis.video.cover_frame.uri,
      shotTitle: slot ? readableSlot({ id: slot.slot_id, label: slot.slot_type, slot, status: "partial", timeRange: formatShotRange(shot), migrationResult: "", materialSummary: "", copy: "" }) : shot.shot_id,
      shotDescription: shot.description,
      migrationPossibility: slot?.migration_rule ?? slot?.content_goal ?? "等待结构提取结果。"
    };
  });
};

const buildV2SampleRows = (table: V2ReferenceAnalysisTable): SampleAnalysisRow[] => {
  return (table.rows ?? []).map((row, index) => ({
      duration: row.duration ?? "",
      image: row.sample_video?.media?.uri ?? "",
      shotTitle: row.shot_description?.title ?? `分镜 ${index + 1}`,
      shotDescription: row.shot_description?.description ?? "",
      migrationPossibility: row.migration_possibility ?? ""
    }));
};

const sampleAnalysisTables: Record<number, SampleAnalysisRow[]> = {
  1: [
    {
      duration: "0 - 2s",
      image: figmaSampleImages[0],
      shotTitle: "开场吸引",
      shotDescription: "口红膏体近景旋出，光线扫过金属管身，突出质感",
      migrationPossibility: "可迁移为粉饼开盖、粉扑轻压、粉质飞散等强特写开场。"
    },
    {
      duration: "2 - 4s",
      image: figmaSampleImages[1],
      shotTitle: "产品展示",
      shotDescription: "模特上唇试色，镜头停留在唇部和产品包装",
      migrationPossibility: "可迁移为粉饼上脸、局部定妆、镜面反光与包装展示。"
    },
    {
      duration: "4 - 6s",
      image: figmaSampleImages[2],
      shotTitle: "情绪氛围",
      shotDescription: "妆容完成后进入聚会场景，强调自信和社交状态",
      migrationPossibility: "可迁移为妆后近景、柔焦肌肤、外出补妆场景。"
    },
    {
      duration: "6 - 8s",
      image: figmaSampleImages[3],
      shotTitle: "行动引导",
      shotDescription: "主角拿起产品完成最后展示，画面聚焦品牌和使用结果",
      migrationPossibility: "可迁移为粉饼遮瑕前后、油光前后、妆面服帖度对比。"
    }
  ],
  2: [
    {
      duration: "0 - 2s",
      image: figmaSampleImages[0],
      shotTitle: "开场吸引",
      shotDescription: "冰镇可乐特写，冰块滑落，突出清爽感",
      migrationPossibility: "用强特写制造产品质感冲击，可迁移为粉饼粉质飞散 / 粉盒打开 / 柔焦肌肤特写。"
    },
    {
      duration: "2 - 4s",
      image: figmaSampleImages[1],
      shotTitle: "产品展示",
      shotDescription: "慢动作倒入冰镇可乐，泡沫溢出杯口，展现诱人口感",
      migrationPossibility: "用材质流动和细节展示产品质感，可迁移为粉质细腻、粉扑按压、粉盒镜面反光。"
    },
    {
      duration: "4 - 6s",
      image: figmaSampleImages[2],
      shotTitle: "情感共鸣",
      shotDescription: "年轻朋友聚会，欢笑畅饮，传递快乐与友谊",
      migrationPossibility: "可迁移为粉扑取粉、按压上脸、鼻翼/脸颊局部定妆。"
    },
    {
      duration: "6 - 8s",
      image: figmaSampleImages[3],
      shotTitle: "行动引导",
      shotDescription: "主角快速拿起手机，开始操作，镜头跟随手部动作，强调产品界面清晰",
      migrationPossibility: "可迁移为粉饼遮瑕前后、油光前后、妆面服帖度对比。"
    }
  ],
  3: [
    {
      duration: "0 - 2s",
      image: figmaSampleImages[0],
      shotTitle: "开场吸引",
      shotDescription: "产品被快速推入镜头中心，用高反差背景制造注意力",
      migrationPossibility: "可迁移为粉盒推近、粉扑落下、定妆前肌肤局部特写。"
    },
    {
      duration: "2 - 4s",
      image: figmaSampleImages[1],
      shotTitle: "卖点展开",
      shotDescription: "用连续细节镜头说明产品质感和核心卖点",
      migrationPossibility: "可迁移为控油、柔焦、遮瑕三个卖点的连续分镜。"
    },
    {
      duration: "4 - 6s",
      image: figmaSampleImages[2],
      shotTitle: "场景验证",
      shotDescription: "进入真实使用环境，展示产品带来的状态变化",
      migrationPossibility: "可迁移为通勤、约会、聚会前后的妆面稳定对比。"
    },
    {
      duration: "6 - 8s",
      image: figmaSampleImages[3],
      shotTitle: "行动引导",
      shotDescription: "结尾给出明确选择理由，镜头回到产品和最终效果",
      migrationPossibility: "可迁移为购买理由总结、色号/肤质选择提示和 CTA。"
    }
  ]
};

const generateMockAnalysis = (filename: string): SampleAnalysisRow[] => {
  const name = filename.replace(/\.[^.]+$/, "");
  return [
    {
      duration: "0 - 2s",
      image: figmaSampleImages[0],
      shotTitle: "开场吸引",
      shotDescription: `${name}产品近景特写，光线扫过包装表面，突出质感与品牌调性`,
      migrationPossibility: "可迁移为粉饼开盖、粉扑轻压、粉质飞散等强特写开场。"
    },
    {
      duration: "2 - 5s",
      image: figmaSampleImages[1],
      shotTitle: "卖点展示",
      shotDescription: `多角度展示${name}核心卖点，镜头聚焦产品细节与使用效果`,
      migrationPossibility: "可迁移为粉饼上脸、局部定妆、镜面反光与包装展示。"
    },
    {
      duration: "5 - 7s",
      image: figmaSampleImages[2],
      shotTitle: "场景验证",
      shotDescription: `真实使用场景中展示${name}带来的状态变化，强调实际效果`,
      migrationPossibility: "可迁移为通勤、约会、聚会前后的妆面稳定对比。"
    },
    {
      duration: "7 - 10s",
      image: figmaSampleImages[3],
      shotTitle: "行动引导",
      shotDescription: `结尾展示${name}最终效果，给出明确选择理由和购买引导`,
      migrationPossibility: "可迁移为购买理由总结、色号/肤质选择提示和 CTA。"
    }
  ];
};

type ExtraSample = {
  name: string;
  status: "loading" | "done";
  rows: SampleAnalysisRow[];
};

const FigmaSampleAnalysisView = ({
  onNext,
  onHome,
  onWorkflowPatch,
  sampleAnalysis,
  sampleFile,
  sampleFiles,
  workflowResult,
  structureBlueprint,
  v2PipelineResult,
  projectName,
  onProjectNameChange
}: {
  onNext: () => void;
  onHome: () => void;
  onWorkflowPatch: (patch: Partial<WorkflowRunResult>) => void;
  sampleAnalysis?: SampleAnalysis;
  sampleFile?: UploadedVideoFile;
  sampleFiles?: UploadedVideoFile[];
  workflowResult: WorkflowRunResult | null;
  structureBlueprint?: StructureBlueprint;
  v2PipelineResult?: V2PipelineResult;
  projectName: string;
  onProjectNameChange: (name: string) => void;
}) => {
  const [activeSample, setActiveSample] = useState(v2PipelineResult || sampleAnalysis ? 0 : 2);
  const [extraSamples, setExtraSamples] = useState<ExtraSample[]>([]);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [tempTitle, setTempTitle] = useState(projectName);
  const addSampleInputRef = useRef<HTMLInputElement>(null);
  const v2Tables = v2PipelineResult?.stages.reference_analysis_tables ?? [];
  const backendSamples = v2PipelineResult
    ? Array.from({
        length: Math.max(v2Tables.length, sampleFiles?.length ?? 0)
      }, (_, index) => {
        const table = v2Tables[index];
        return {
          label:
            sampleFiles?.[index]?.original_filename ??
            table?.source_label ??
            `样例 ${index + 1}`,
          rows: table ? buildV2SampleRows(table) : []
        };
      })
    : sampleAnalysis
      ? [
          {
            label: sampleFile?.original_filename ?? "口红广告",
            rows: buildBackendSampleRows(sampleAnalysis, structureBlueprint)
          }
        ]
      : [];
  const hasBackendSamples = backendSamples.length > 0;
  const sourceLabel = projectName;

  const baseSampleCount = hasBackendSamples ? backendSamples.length : 3;

  const getCurrentGoal = (): string => {
    const scriptGoal = workflowResult?.scriptSession?.user_request.goal;
    return typeof scriptGoal === "string" && scriptGoal.trim()
      ? scriptGoal
      : projectName;
  };

  const handleAddSample = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const selectedFiles = Array.from(files);
    e.target.value = "";

    if (v2PipelineResult) {
      const firstNewIndex = baseSampleCount + extraSamples.length;
      setExtraSamples((prev) => [
        ...prev,
        ...selectedFiles.map((file) => ({
          name: file.name,
          status: "loading" as const,
          rows: []
        }))
      ]);
      setActiveSample(firstNewIndex);

      try {
        const uploadedSample = await uploadSampleVideos(selectedFiles);
        const nextSampleFiles = [...(sampleFiles ?? []), ...uploadedSample.files];
        const goal = getCurrentGoal();
        const pipelineResult = await analyzeV2Pipeline({
          reference_file_ids: nextSampleFiles.map((file) => file.file_id),
          user_material_file_ids: workflowResult?.materialFiles.map((file) => file.file_id) ?? [],
          text_assets: [
            {
              asset_id: "brief_01",
              type: "brief",
              content: goal
            }
          ],
          user_request: {
            goal
          },
          options: {
            allow_fallback: true,
            generate_image_candidates: false,
            image_candidate_count: 4,
            target_duration_seconds: v2PipelineResult.summary.target_duration_seconds
          }
        });
        const scriptSession = await createV2ScriptSession({
          pipeline_result: pipelineResult,
          user_request: {
            goal
          },
          target_duration_seconds: pipelineResult.summary.target_duration_seconds
        });

        onWorkflowPatch({
          sampleFile: nextSampleFiles[0],
          sampleFiles: nextSampleFiles,
          scriptSession,
          v2PipelineResult: pipelineResult,
          canvasRevalidateResult: undefined,
          canvasSession: undefined,
          finalAssembly: undefined,
          finalVideo: undefined
        });
        setExtraSamples([]);
        setActiveSample(Math.max(0, nextSampleFiles.length - 1));
      } catch (error) {
        console.warn("Failed to add v2 sample video.", error);
        setExtraSamples((prev) =>
          prev.map((sample, index) =>
            index >= prev.length - selectedFiles.length
              ? { ...sample, status: "done" as const, rows: [] }
              : sample
          )
        );
      }

      return;
    }

    selectedFiles.forEach((file, fileIdx) => {
      const newIndex = baseSampleCount + extraSamples.length + fileIdx;
      const placeholder: ExtraSample = {
        name: file.name,
        status: "loading",
        rows: []
      };

      setExtraSamples((prev) => [...prev, placeholder]);
      setActiveSample(newIndex);

      // Simulate AI analysis with 1.5s delay
      setTimeout(() => {
        setExtraSamples((prev) =>
          prev.map((s, i) =>
            i === prev.length - 1 - (files.length - 1 - fileIdx)
              ? { ...s, status: "done" as const, rows: generateMockAnalysis(file.name) }
              : s
          )
        );
      }, 1500);
    });
  };

  // Determine which rows to show
  const getActiveRows = (): { rows: SampleAnalysisRow[] | null; loading: boolean; label: string } => {
    const extraIdx = activeSample - baseSampleCount;
    if (extraIdx >= 0 && extraIdx < extraSamples.length) {
      const extra = extraSamples[extraIdx];
      return {
        rows: extra.status === "done" ? extra.rows : null,
        loading: extra.status === "loading",
        label: extra.name
      };
    }

    if (hasBackendSamples) {
      const sample = backendSamples[activeSample] ?? backendSamples[0];
      return {
        rows: sample.rows,
        loading: false,
        label: sample.label
      };
    }

    return {
      rows: sampleAnalysisTables[activeSample] ?? sampleAnalysisTables[1],
      loading: false,
      label: sampleFile?.original_filename ?? "口红广告"
    };
  };

  const active = getActiveRows();

  const saveTitle = () => {
    setIsEditingTitle(false);
    if (tempTitle.trim()) {
      onProjectNameChange(tempTitle.trim());
    } else {
      setTempTitle(projectName);
    }
  };

  return (
    <div className="figma-analysis-page">
      <header className="figma-analysis-topbar">
        <div className="figma-analysis-brand">
          <button className="figma-brand-home" onClick={onHome} type="button">
            迁镜
          </button>
          {isEditingTitle ? (
            <input
              autoFocus
              className="figma-edit-input"
              value={tempTitle}
              onChange={(e) => setTempTitle(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTitle();
                if (e.key === "Escape") {
                  setIsEditingTitle(false);
                  setTempTitle(projectName);
                }
              }}
            />
          ) : (
            <>
              <strong>{projectName}</strong>
              <button aria-label="编辑项目名称" className="figma-edit-icon" type="button" onClick={() => setIsEditingTitle(true)}>
                ✎
              </button>
            </>
          )}
        </div>
        <div className="figma-analysis-avatar" aria-hidden="true" />
      </header>

      <button className="figma-migration-button" onClick={onNext} type="button">
        <span>结构迁移</span>
        <span aria-hidden="true">›</span>
      </button>

      {/* Hidden file input for adding new sample videos */}
      <input
        ref={addSampleInputRef}
        type="file"
        accept="video/mp4,video/quicktime,video/webm"
        style={{ display: 'none' }}
        onChange={handleAddSample}
      />

      <div className="figma-analysis-content">
        <nav className="figma-sample-nav" aria-label="样例视频">
          {(hasBackendSamples ? backendSamples.map((_, index) => index) : [1, 2, 3]).map((sampleNumber) => (
            <button
              className={sampleNumber === activeSample ? "active" : ""}
              key={sampleNumber}
              onClick={() => setActiveSample(sampleNumber)}
              type="button"
            >
              {hasBackendSamples ? sampleNumber + 1 : sampleNumber}
            </button>
          ))}
          {extraSamples.map((_, i) => (
            <button
              className={activeSample === baseSampleCount + i ? "active" : ""}
              key={`extra-${i}`}
              onClick={() => setActiveSample(baseSampleCount + i)}
              type="button"
            >
              {baseSampleCount + i + 1}
            </button>
          ))}
          <button
            className="add-sample-btn"
            type="button"
            aria-label="添加样例"
            onClick={() => addSampleInputRef.current?.click()}
          >
            +
          </button>
        </nav>

        <main className="figma-analysis-table-wrap">
          {active.loading ? (
            <div className="figma-analysis-loading">
              <div className="analysis-spinner" />
              <p>正在解析样例视频…</p>
              <span>{active.label}</span>
            </div>
          ) : (
            <div className="figma-analysis-table" role="table" aria-label="样例解析">
              <div className="figma-analysis-row figma-analysis-head" role="row">
                <div role="columnheader" style={{ width: '80px', flexShrink: 0 }}>时长</div>
                <div role="columnheader" style={{ width: '300px', flexShrink: 0 }}>样例视频</div>
                <div role="columnheader" style={{ width: '280px', flexShrink: 0 }}>分镜描述</div>
                <div role="columnheader" style={{ width: '360px', flexShrink: 0 }}>迁移可能性</div>
              </div>
              {(active.rows ?? []).map((row) => (
                <div className="figma-analysis-row" key={`${activeSample}-${row.duration}`} role="row">
                  <div className="duration-cell" role="cell">
                    {row.duration}
                  </div>
                  <div className="sample-media-cell" role="cell">
                    {row.image ? <img alt="" src={row.image} /> : <PlaceholderBlock label={active.label} />}
                  </div>
                  <div className="shot-desc-cell" role="cell">
                    <strong>{row.shotTitle}</strong>
                    <span>{row.shotDescription}</span>
                  </div>
                  <div className="migration-possibility-cell" role="cell">
                    {row.migrationPossibility}
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

const StructureMigrationView = ({
  blocks,
  materialFiles,
  onUpdateBlock,
  onReorderBlocks,
  onStepChange,
  onHome,
  onWorkflowPatch,
  projectName,
  onProjectNameChange,
  scriptSession
}: {
  blocks: CanvasBlock[];
  materialFiles: UploadedVideoFile[];
  onUpdateBlock: (updatedBlock: CanvasBlock) => void;
  onReorderBlocks: (orderedIds: string[]) => void;
  onStepChange: (step: StepKey) => void;
  onHome: () => void;
  onWorkflowPatch: (patch: Partial<WorkflowRunResult>) => void;
  projectName?: string;
  onProjectNameChange?: (name: string) => void;
  scriptSession?: V2ScriptSession;
}) => {
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [localMaterials, setLocalMaterials] = useState<Record<string, string[]>>({});
  const [pendingMaterialBlockId, setPendingMaterialBlockId] = useState<string | null>(null);
  const [tempTitle, setTempTitle] = useState(projectName ?? "");
  const materialInputRef = useRef<HTMLInputElement>(null);

  const title = projectName ?? "未命名项目";

  const saveTitle = () => {
    if (tempTitle.trim() && onProjectNameChange) {
      onProjectNameChange(tempTitle.trim());
    }
    setIsEditingTitle(false);
  };

  const openMaterialPicker = (blockId: string) => {
    setPendingMaterialBlockId(blockId);
    materialInputRef.current?.click();
  };

  const handleMaterialPick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (!pendingMaterialBlockId || files.length === 0) {
      event.target.value = "";
      return;
    }

    setLocalMaterials((prev) => ({
      ...prev,
      [pendingMaterialBlockId]: [
        ...(prev[pendingMaterialBlockId] ?? []),
        ...files.map((file) => file.name)
      ]
    }));
    setPendingMaterialBlockId(null);
    event.target.value = "";
  };

  const syncScriptSlot = async (
    block: CanvasBlock,
    payload: {
      required_duration?: number;
      voiceover_text?: string;
      copy?: string;
    }
  ) => {
    if (!scriptSession) {
      return;
    }

    try {
      const nextSession = await updateV2ScriptSlot(
        scriptSession.session_id,
        block.id,
        payload
      );
      onWorkflowPatch({ scriptSession: nextSession });
    } catch (error) {
      console.warn("V2 script slot sync failed.", error);
    }
  };

  const handleDrop = async (targetId: string) => {
    if (!dragId || dragId === targetId) {
      setDragId(null);
      setDropTargetId(null);
      return;
    }
    const ids = blocks.map((block) => block.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) {
      setDragId(null);
      setDropTargetId(null);
      return;
    }
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    onReorderBlocks(ids);
    if (scriptSession) {
      try {
        const nextSession = await reorderV2ScriptSlots(scriptSession.session_id, ids);
        onWorkflowPatch({ scriptSession: nextSession });
      } catch (error) {
        console.warn("V2 script slot reorder failed.", error);
      }
    }
    setDragId(null);
    setDropTargetId(null);
  };

  const enterCanvas = async () => {
    if (!scriptSession) {
      onStepChange("gap-fill");
      return;
    }

    try {
      const revalidateResult = await revalidateV2Canvas({
        session_id: scriptSession.session_id,
        persist_canvas_session: true
      });
      onWorkflowPatch({
        canvasRevalidateResult: revalidateResult,
        canvasSession: revalidateResult.canvas_session
      });
    } catch (error) {
      console.warn("V2 canvas revalidate failed.", error);
    }
    onStepChange("gap-fill");
  };

  const stopDrag = (event: { stopPropagation: () => void }) => event.stopPropagation();

  return (
    <div className="figma-analysis-page migration-page">
      <header className="figma-analysis-topbar">
        <div className="figma-analysis-brand">
          <button className="figma-brand-home" onClick={onHome} type="button">
            迁镜
          </button>
          {isEditingTitle ? (
            <input
              autoFocus
              className="figma-edit-input"
              value={tempTitle}
              onChange={(event) => setTempTitle(event.target.value)}
              onBlur={saveTitle}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveTitle();
                if (event.key === "Escape") {
                  setIsEditingTitle(false);
                  setTempTitle(title);
                }
              }}
            />
          ) : (
            <>
              <strong>{title}</strong>
              <button
                aria-label="编辑项目名称"
                className="figma-edit-icon"
                type="button"
                onClick={() => {
                  setTempTitle(title);
                  setIsEditingTitle(true);
                }}
              >
                ✎
              </button>
            </>
          )}
        </div>
        <div className="figma-analysis-avatar" aria-hidden="true" />
      </header>

      <input
        ref={materialInputRef}
        type="file"
        accept="image/*,video/*,.txt,.md"
        multiple
        style={{ display: "none" }}
        onChange={handleMaterialPick}
      />

      <section className="migration-fixed-frame">
        <div className="migration-toolbar">
          <button
            type="button"
            className="migration-nav-button migration-nav-back"
            onClick={() => onStepChange("analysis")}
          >
            <span aria-hidden="true">‹</span>
            <span>样例拆解</span>
          </button>
          <span className="migration-hint">拖动块来调整结构，点击块编辑节奏与旁白</span>
          <button
            type="button"
            className="migration-nav-button migration-nav-forward"
            onClick={enterCanvas}
          >
            <span>进入画布</span>
            <span aria-hidden="true">›</span>
          </button>
        </div>
      </section>

      <div className="migration-scroll">
        <div className="migration-matrix-container">
          <div className="migration-matrix">
            <div className="migration-header">
              <span className="migration-col col-desc">分镜描述</span>
              <span className="migration-col col-duration">时长</span>
              <span className="migration-col col-voiceover">旁白</span>
              <span className="migration-col col-material">我的素材</span>
              <span className="migration-col col-add">添加素材</span>
            </div>

            <div className="migration-rows">
              {blocks.map((block, index) => {
                const isSelected = selectedRowId === block.id;
                const voiceoverText = getEditableVoiceoverText(block);
                const materialItems = getMigrationMaterialItems(
                  block,
                  materialFiles[index],
                  localMaterials[block.id] ?? []
                );
                const rowClass = [
                  "migration-row",
                  isSelected ? "selected" : "",
                  dragId === block.id ? "dragging" : "",
                  dropTargetId === block.id ? "drop-target" : ""
                ]
                  .filter(Boolean)
                  .join(" ");

                return (
                  <div
                    key={block.id}
                    className={rowClass}
                    draggable={!isSelected}
                    onDragStart={() => setDragId(block.id)}
                    onDragOver={(event) => {
                      event.preventDefault();
                      if (dropTargetId !== block.id) {
                        setDropTargetId(block.id);
                      }
                    }}
                    onDrop={() => handleDrop(block.id)}
                    onDragEnd={() => {
                      setDragId(null);
                      setDropTargetId(null);
                    }}
                    onClick={() => setSelectedRowId(block.id)}
                  >
                    {/* 分镜描述: 只读纯文字 */}
                    <div className="migration-col col-desc">
                      <div className="desc-tag">
                        <span className="desc-tag-name">{readableSlot(block)}</span>
                        <span className="desc-tag-index">{sourceReferenceMarks(block, index)}</span>
                      </div>
                      <div className="desc-body">{block.migrationResult}</div>
                    </div>

                    {/* 时长: 可编辑 */}
                    <div className="migration-col col-duration editable">
                      <input
                        type="text"
                        className="migration-duration-input"
                        value={block.timeRange}
                        onMouseDown={stopDrag}
                        onClick={stopDrag}
                        onChange={(event) =>
                          onUpdateBlock({ ...block, timeRange: event.target.value })
                        }
                        onBlur={(event) => {
                          const requiredDuration = parseDurationSeconds(event.target.value);
                          if (requiredDuration) {
                            syncScriptSlot(block, { required_duration: requiredDuration });
                          }
                        }}
                        placeholder="3s"
                      />
                    </div>

                    {/* 旁白: 可编辑 */}
                    <div className="migration-col col-voiceover editable">
                      <textarea
                        className="migration-voiceover-input"
                        value={voiceoverText}
                        onMouseDown={stopDrag}
                        onClick={stopDrag}
                        onChange={(event) => {
                          const updatedTimeline = block.timeline
                            ? { ...block.timeline, voiceover: event.target.value }
                            : {
                                item_id: `tl_${block.id}`,
                                slot_id: block.id,
                                time_range: block.timeRange,
                                slot_type: block.slot.slot_type,
                                content_goal: block.slot.content_goal,
                                visual_source: "user_material",
                                visual_description: "",
                                subtitle: event.target.value,
                                voiceover: event.target.value,
                                transition: "none"
                              };
                          onUpdateBlock({ ...block, timeline: updatedTimeline });
                        }}
                        onBlur={(event) => {
                          syncScriptSlot(block, {
                            copy: event.target.value,
                            voiceover_text: event.target.value
                          });
                        }}
                        placeholder="输入旁白文本..."
                        rows={2}
                      />
                    </div>

                    {/* 我的素材: 只读，过多时框内滚动 */}
                    <div className="migration-col col-material">
                      <div className="material-scroll">
                        {materialItems.map((material, materialIndex) => (
                          <div
                            className="material-item"
                            key={`${block.id}-${material.name}-${materialIndex}`}
                          >
                            <div className="material-name">{material.name}</div>
                            {material.note ? (
                              <div className="material-note">{material.note}</div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="migration-col col-add">
                      <button
                        className="migration-add-material"
                        type="button"
                        aria-label="添加素材"
                        title="添加素材"
                        onMouseDown={stopDrag}
                        onClick={(event) => {
                          event.stopPropagation();
                          openMaterialPicker(block.id);
                        }}
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const GapFillView = ({
  canvasSession,
  blocks,
  onSelectBlock,
  onUpdateBlock,
  onStepChange,
  onWorkflowPatch,
  selectedBlockId,
  scriptSession,
  projectName
}: {
  canvasSession?: V2CanvasSession;
  blocks: CanvasBlock[];
  onNext: () => void;
  onSelectBlock: (blockId: string) => void;
  onUpdateBlock: (updatedBlock: CanvasBlock) => void;
  onStepChange: (step: StepKey) => void;
  onWorkflowPatch: (patch: Partial<WorkflowRunResult>) => void;
  selectedBlockId: string;
  scriptSession?: V2ScriptSession;
  projectName?: string;
}) => {
  const exportFinalVideo = async () => {
    if (!canvasSession) {
      onStepChange("demo");
      return;
    }

    try {
      const finalVideo = await assembleV2CanvasFinalVideo(
        canvasSession.canvas_session_id,
        {
          generate_bgm: true
        }
      );
      onWorkflowPatch({
        canvasSession: finalVideo.canvas_session,
        canvasSessionId: finalVideo.canvas_session?.canvas_session_id,
        finalAssembly: finalVideo.final_assembly,
        finalVideo
      });
    } catch (error) {
      console.warn("V2 final assembly failed.", error);
    }
    onStepChange("demo");
  };

  return (
    <div className="gap-fill-page">
      <VideoBlockCanvas
        blocks={blocks}
        canvasSessionId={canvasSession?.canvas_session_id}
        onBack={() => onStepChange("migration")}
        onCanvasSessionChange={(nextCanvasSession) =>
          onWorkflowPatch({ canvasSession: nextCanvasSession })
        }
        onExport={exportFinalVideo}
        onSelectBlock={onSelectBlock}
        onUpdateBlock={onUpdateBlock}
        projectName={projectName}
        selectedBlockId={selectedBlockId}
      />
    </div>
  );
};

type PreviewSegment = {
  id: string;
  label: string;
  thumbnail: string;
  videoUrl?: string;
  start: number;
  duration: number;
  end: number;
  aiGenerated: boolean;
};

const previewImages = [
  "https://www.figma.com/api/mcp/asset/7a9bb822-f69c-4344-9da9-27ec440b9d2e",
  "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=1400&q=85",
  "https://www.figma.com/api/mcp/asset/45d15bc2-c541-433f-9c4c-2a1db76e627d",
  "https://images.unsplash.com/photo-1517701604599-bb29b565090c?auto=format&fit=crop&w=1400&q=85",
  "https://www.figma.com/api/mcp/asset/27f882c5-4b54-4e3e-b9b7-811c7dfe6429"
];

const coverImageAsset = "/cover-coffee.png";

const parseRangeDuration = (value: string) => {
  const matches = value.match(/(\d+(?:\.\d+)?)/g)?.map(Number) ?? [];
  if (matches.length >= 2 && matches[1] > matches[0]) {
    return Number((matches[1] - matches[0]).toFixed(2));
  }
  return 4;
};

const getRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const getString = (value: unknown) => (typeof value === "string" ? value : undefined);

const getCanvasSessionId = (result?: WorkflowRunResult | null) => {
  if (!result) {
    return undefined;
  }
  const sessionId = result.canvasSessionId || getString(getRecord(result.canvasSession).canvas_session_id);
  return sessionId || getString(getRecord(result.canvasSession).id);
};

const getFinalVideoUrl = (result?: WorkflowRunResult | null) => {
  return (
    result?.finalAssembly?.final_video_url ||
    result?.finalVideo?.final_assembly?.final_video_url ||
    getString(getRecord(result?.finalVideo).final_video_url)
  );
};

const downloadUrl = (url: string, filename: string) => {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
};

const buildPreviewSegments = (blocks: CanvasBlock[], workflowResult?: WorkflowRunResult | null) => {
  const finalAssembly = workflowResult?.finalAssembly ?? workflowResult?.finalVideo?.final_assembly;
  const assemblySlots = Array.isArray(finalAssembly?.slots) ? finalAssembly.slots : [];
  let cursor = 0;

  return blocks.map((block, index): PreviewSegment => {
    const slotRecord = getRecord(assemblySlots[index]);
    const duration =
      Number(slotRecord.duration_seconds) ||
      Number((block.slot as unknown as Record<string, unknown>).required_duration) ||
      parseRangeDuration(block.timeRange);
    const videoUrl = getString(slotRecord.video_uri) || getString(slotRecord.final_video_url);
    const start = cursor;
    const aiGenerated =
      block.timeline?.visual_source?.toLowerCase().includes("ai") ||
      block.materialSummary.toLowerCase().includes("ai");

    cursor += duration;

    return {
      id: block.id,
      label: readableSlot(block),
      thumbnail: getString(slotRecord.thumbnail_url) || previewImages[index % previewImages.length],
      videoUrl,
      start,
      duration,
      end: cursor,
      aiGenerated
    };
  });
};

const PlayIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d="M8 5v14l11-7z" />
  </svg>
);

const PauseIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d="M8 5v14" />
    <path d="M16 5v14" />
  </svg>
);

const ShareIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d="M12 4v10" />
    <path d="m8 8 4-4 4 4" />
    <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
  </svg>
);

const ChevronLeftIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d="m15 18-6-6 6-6" />
  </svg>
);

const ChevronRightIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d="m9 18 6-6-6-6" />
  </svg>
);

const DemoView = ({
  blocks,
  onStepChange,
  projectName,
  workflowResult
}: {
  blocks: CanvasBlock[];
  onStepChange: (step: StepKey) => void;
  projectName?: string;
  workflowResult?: WorkflowRunResult | null;
}) => {
  const segments = useMemo(
    () => buildPreviewSegments(blocks, workflowResult),
    [blocks, workflowResult]
  );
  const totalDuration = segments.at(-1)?.end ?? 0;
  const [activeIndex, setActiveIndex] = useState(0);
  const [coverModalOpen, setCoverModalOpen] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const [exportStatus, setExportStatus] = useState<"idle" | "exporting" | "success" | "error">("idle");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPreparing, setIsPreparing] = useState(true);
  const [playhead, setPlayhead] = useState(0);
  const [previewHovered, setPreviewHovered] = useState(false);
  const [coverTitle, setCoverTitle] = useState(projectName || "一杯好咖啡 开启美好一天");
  const [coverIntro, setCoverIntro] = useState("精选咖啡豆，匠心烘焙，香醇顺滑，回味悠长。");
  const currentSegment = segments[activeIndex] ?? segments[0];
  const finalVideoUrl = getFinalVideoUrl(workflowResult);
  const finalVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setIsPreparing(false), 760);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (finalVideoUrl || !isPlaying || totalDuration <= 0) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setPlayhead((current) => {
        const next = Math.min(totalDuration, Number((current + 0.1).toFixed(2)));
        const nextIndex = segments.findIndex((segment) => next >= segment.start && next < segment.end);
        if (nextIndex >= 0 && nextIndex !== activeIndex) {
          setActiveIndex(nextIndex);
        }
        if (next >= totalDuration) {
          setIsPlaying(false);
        }
        return next;
      });
    }, 100);

    return () => window.clearInterval(timer);
  }, [activeIndex, finalVideoUrl, isPlaying, segments, totalDuration]);

  useEffect(() => {
    const video = finalVideoRef.current;
    if (!video) {
      return;
    }

    if (isPlaying) {
      void video.play().catch(() => setIsPlaying(false));
    } else {
      video.pause();
    }
  }, [isPlaying]);

  const startFrom = (index: number) => {
    const segment = segments[index];
    if (!segment) {
      return;
    }
    setActiveIndex(index);
    setPlayhead(segment.start);
    if (finalVideoRef.current) {
      finalVideoRef.current.currentTime = segment.start;
    }
    setIsPlaying(true);
  };

  const togglePlayback = () => {
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    if (playhead >= totalDuration) {
      setPlayhead(currentSegment?.start ?? 0);
      if (finalVideoRef.current) {
        finalVideoRef.current.currentTime = currentSegment?.start ?? 0;
      }
    }
    setIsPlaying(true);
  };

  const handleVideoTimeUpdate = () => {
    const video = finalVideoRef.current;
    if (!video) {
      return;
    }

    const current = video.currentTime;
    setPlayhead(current);
    const nextIndex = segments.findIndex((segment) => current >= segment.start && current < segment.end);
    if (nextIndex >= 0) {
      setActiveIndex(nextIndex);
    }
  };

  const handlePreviewKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== " " || !previewHovered) {
      return;
    }
    event.preventDefault();
    togglePlayback();
  };

  const handleGenerateCoverCopy = () => {
    setCoverTitle(projectName ? `${projectName}，一眼心动` : "一杯好咖啡 开启美好一天");
    setCoverIntro("用高光画面抓住第一眼，把产品卖点压缩成一句能传播的标题。");
  };

  const handleExport = async () => {
    if (exportStatus === "exporting") {
      return;
    }

    setExportStatus("exporting");
    setExportMessage("");

    try {
      const canvasSessionId = getCanvasSessionId(workflowResult);
      let exportedUrl = finalVideoUrl;

      if (canvasSessionId) {
        const result = await assembleV2CanvasFinalVideo(canvasSessionId, {
          resolution: "1280x720",
          fps: 24,
          background_color: "black",
          allow_loop_short_clips: true,
          generate_bgm: true
        });
        exportedUrl = result.final_assembly?.final_video_url;
      } else {
        const slots: V2FinalAssemblySlot[] = segments
          .filter((segment) => segment.videoUrl)
          .map((segment) => ({
            slot_id: segment.id,
            slot_type: segment.label,
            video_uri: segment.videoUrl ?? "",
            duration_seconds: segment.duration,
            start_seconds: 0
          }));

        if (slots.length === segments.length && slots.length > 0) {
          const result = await assembleV2FinalVideo({
            slots,
            resolution: "1280x720",
            fps: 24,
            background_color: "black",
            allow_loop_short_clips: true,
            generate_bgm: true
          });
          exportedUrl = result.final_video_url;
        } else {
          await new Promise((resolve) => window.setTimeout(resolve, 1100));
        }
      }

      if (exportedUrl) {
        downloadUrl(exportedUrl, `${projectName || "shotswift"}-final.mp4`);
      }

      setExportStatus("success");
      setExportMessage("导出成功！快去分享你的作品吧~");
    } catch (error) {
      setExportStatus("error");
      setExportMessage(error instanceof Error ? error.message : "导出失败，请稍后再试。");
    }
  };

  const progress = totalDuration > 0 ? Math.min(100, (playhead / totalDuration) * 100) : 0;

  return (
    <div className="preview-page">
      <header className="preview-topbar">
        <div className="preview-brand">
          <span>迁镜</span>
          <strong>{projectName || "口红广告"}</strong>
          <i aria-hidden="true">✎</i>
        </div>
        <div className="figma-analysis-avatar" aria-label="用户头像" />
      </header>

      <div className="preview-action-row">
        <button className="preview-back-button" type="button" onClick={() => onStepChange("gap-fill")}>
          <ChevronLeftIcon />
          返回画布
        </button>
        <button className="preview-cover-button" type="button" onClick={() => setCoverModalOpen(true)}>
          制作封面
          <ChevronRightIcon />
        </button>
      </div>

      <main className="preview-stage" aria-busy={isPreparing}>
        <aside className="preview-strip" aria-label="视频片段列表">
          {segments.map((segment, index) => (
            <button
              className={`preview-thumb ${index === activeIndex ? "active" : ""}`}
              key={segment.id}
              onClick={() => startFrom(index)}
              type="button"
            >
              <img alt={segment.label} src={segment.thumbnail} />
              {index !== activeIndex ? <span className="preview-thumb-dim" /> : null}
              {segment.aiGenerated ? <em>AI</em> : null}
            </button>
          ))}
        </aside>

        <section className="preview-main">
          <div
            className="preview-screen"
            onClick={togglePlayback}
            onKeyDown={handlePreviewKeyDown}
            onMouseEnter={() => setPreviewHovered(true)}
            onMouseLeave={() => setPreviewHovered(false)}
            role="button"
            tabIndex={0}
          >
            {finalVideoUrl ? (
              <video
                muted
                onEnded={() => setIsPlaying(false)}
                onTimeUpdate={handleVideoTimeUpdate}
                ref={finalVideoRef}
                src={finalVideoUrl}
              />
            ) : (
              <img alt={currentSegment?.label ?? "视频预览"} src={currentSegment?.thumbnail ?? previewImages[0]} />
            )}
            {isPreparing ? (
              <div className="preview-loading">
                <span />
                <strong>正在准备预览串播...</strong>
              </div>
            ) : (
              <div className="preview-play-mask">
                {isPlaying ? <PauseIcon /> : <PlayIcon />}
              </div>
            )}
          </div>

          <div className="preview-progress" aria-label="播放进度">
            <span style={{ width: `${progress}%` }} />
          </div>

          <div className="preview-controls" aria-label="播放控制">
            <button
              aria-pressed={isPlaying}
              className={isPlaying ? "active" : ""}
              type="button"
              title="播放"
              onClick={() => setIsPlaying(true)}
            >
              <PlayIcon />
            </button>
            <button
              aria-pressed={!isPlaying}
              className={!isPlaying ? "active" : ""}
              type="button"
              title="暂停"
              onClick={() => setIsPlaying(false)}
            >
              <PauseIcon />
            </button>
          </div>

          <p className="preview-status">
            {finalVideoUrl
              ? "已连接最终视频结果。"
              : "当前使用 mock 串播预览；后端返回最终视频后会自动切换为真实视频导出。"}
          </p>
        </section>
      </main>

      {coverModalOpen ? (
        <div className="cover-modal" role="dialog" aria-modal="true" aria-label="封面与标题生成">
          <div className="cover-modal-shell">
            <button
              aria-label="关闭封面制作"
              className="cover-modal-close"
              type="button"
              onClick={() => setCoverModalOpen(false)}
            >
              ×
            </button>
            <main className="cover-modal-body">
              <aside className="cover-prompts" aria-label="封面提示词">
                <section className="cover-prompt-card">
                  <p>
                    请你扮演一位专业广告文案策划，为一款咖啡产品生成广告标题和简介。产品信息如下：
                    品牌名：晨野咖啡。咖啡类型：低糖冷萃咖啡。目标人群：上班族、学生。
                  </p>
                  <button type="button" onClick={handleGenerateCoverCopy}>生成标题简介</button>
                </section>
                <section className="cover-prompt-card cover-prompt-card-tall">
                  <p>
                    请生成一张高质感咖啡广告封面图。画面主体是一杯“晨野咖啡”低糖冷萃咖啡，放置在干净的办公桌或木质桌面上，旁边有笔记本电脑、书本、阳光洒落的窗边场景，营造清晨灵感和工作效率均衡的氛围。画面风格：高级感、清爽、自然、治愈。色调：浅棕色、奶油白、暖阳金。少量深咖色。
                  </p>
                  <button type="button">生成封面</button>
                </section>
              </aside>

              <section className="cover-preview-card">
                <div className="cover-copy">
                  <h2>{coverTitle}</h2>
                  <p>{coverIntro}</p>
                </div>
                <div className="cover-art">
                  <img alt="封面预览" src={coverImageAsset} />
                </div>
              </section>
            </main>

            <button
              className={`cover-export-button ${exportStatus === "exporting" ? "loading" : ""}`}
              type="button"
              title="导出成品"
              onClick={handleExport}
            >
              {exportStatus === "exporting" ? <span /> : <ShareIcon />}
              导出成品
            </button>
            {exportMessage ? (
              <p className={`cover-export-message ${exportStatus}`}>{exportMessage}</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
};

const LegacyDemoView = ({
  blocks,
  finalVideoResult,
  onStepChange
}: {
  blocks: CanvasBlock[];
  finalVideoResult?: V2CanvasFinalVideoResult;
  onStepChange: (step: StepKey) => void;
  projectName?: string;
}) => {
  const finalVideoUrl = finalVideoResult?.final_assembly?.final_video_url;

  return (
    <div className="page-shell demo-page">
      <CanvasTopBar
        actionLabel="返回画布"
        activeStep="demo"
        onNext={() => onStepChange("gap-fill")}
        onStepChange={onStepChange}
        subtitle="演示页面保留视频预览、时间线和人工调整入口，渲染与 ASR 暂时作为 mock 展示。"
        title="迁移结果演示"
      />

      <section className="demo-layout">
        <div className="video-preview">
          {finalVideoUrl ? (
            <video className="preview-canvas" controls src={finalVideoUrl} />
          ) : (
            <div className="preview-canvas">
              <span>新手养猫怎么选猫粮</span>
              <strong>别盲买猫粮</strong>
              <p>结构迁移预览</p>
            </div>
          )}
          <div className="scrubber">
            <span />
          </div>
        </div>

        <aside className="content-card editor-panel">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">Manual Edit</span>
              <h2>人工调整区</h2>
            </div>
          </div>
          <div className="edit-control">
            <span>字幕密度</span>
            <strong>高</strong>
          </div>
          <div className="edit-control">
            <span>标题包装</span>
            <strong>红色警示</strong>
          </div>
          <button
            className="primary-action full"
            onClick={() => {
              if (finalVideoUrl) {
                window.open(finalVideoUrl, "_blank", "noopener,noreferrer");
              }
            }}
            type="button"
          >
            导出结果
          </button>
        </aside>
      </section>

      <section className="content-card timeline-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Timeline</span>
            <h2>分镜 / 时间线</h2>
          </div>
          <p>9:16 · 可横向浏览</p>
        </div>
        <div className="timeline-strip">
          {blocks.map((block, index) => (
            <button className="timeline-item" key={block.id} type="button">
              <span>{block.timeRange}</span>
              <strong>{readableSlot(block)}</strong>
              <small>{readableSource(block.timeline?.visual_source)}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
};
