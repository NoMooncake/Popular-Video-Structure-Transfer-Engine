import { useState, useRef } from "react";
import type { ChangeEvent } from "react";

import type { WorkflowRunResult } from "../App";
import {
  analyzeSampleVideo,
  extractStructureBlueprint,
  uploadMaterialFiles,
  uploadSampleVideos
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
  UploadedVideoFile
} from "../types";
import { StatusBadge } from "./StatusBadge";
import { VideoBlockCanvas } from "./VideoBlockCanvas";

type WorkspaceViewsProps = {
  activeStep: StepKey;
  blocks: CanvasBlock[];
  materialFiles: UploadedVideoFile[];
  onSelectBlock: (blockId: string) => void;
  onUpdateBlock: (updatedBlock: CanvasBlock) => void;
  onStepChange: (step: StepKey) => void;
  onWorkflowReady: (result: WorkflowRunResult) => void;
  sampleAnalysis?: SampleAnalysis;
  sampleFile?: UploadedVideoFile;
  selectedBlock: CanvasBlock;
  selectedBlockId: string;
  structureBlueprint?: StructureBlueprint;
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
    key: "gap-detail",
    label: "缺口详情",
    description: "逐项解释缺什么、为什么缺、怎么补"
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

const migrationRuleByType: Record<string, string> = {
  risk_or_pain_hook: "把样例的风险前置结构迁移为新主题的购买风险提示。",
  pain_desire: "把样例的背景铺垫压缩为用户需求分层说明。",
  product_reveal: "把样例的多产品拆解迁移为短视频中的分类推荐卡片。",
  proof_comparison: "把样例的解释段落迁移为可视化对比证明。",
  decision_warning: "把样例的避坑知识迁移为消费决策前的提醒。",
  cta: "把样例的评论互动结尾迁移为按猫咪情况咨询 of CTA。"
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

const readableSlot = (block: CanvasBlock) => slotLabelByType[block.slot.slot_type] ?? block.label;

const readableGoal = (block: CanvasBlock) => {
  return slotGoalByType[block.slot.slot_type] ?? block.slot.content_goal;
};

const readableRule = (block: CanvasBlock) => {
  return migrationRuleByType[block.slot.slot_type] ?? block.slot.migration_rule;
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

const toBackendCategory = (value: string) => {
  if (value.includes("猫") || value.toLowerCase().includes("pet")) {
    return "pet_food";
  }

  return value.trim() || "pet_food";
};

export const WorkspaceViews = ({
  activeStep,
  blocks,
  materialFiles,
  onSelectBlock,
  onUpdateBlock,
  onStepChange,
  onWorkflowReady,
  sampleAnalysis,
  sampleFile,
  selectedBlock,
  selectedBlockId,
  structureBlueprint
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
        sampleAnalysis={sampleAnalysis}
        sampleFile={sampleFile}
        structureBlueprint={structureBlueprint}
      />
    );
  }

  if (activeStep === "migration") {
    return (
      <StructureMigrationView
        blocks={blocks}
        materialFiles={materialFiles}
        onNext={() => onStepChange("gap-fill")}
        onUpdateBlock={onUpdateBlock}
        onStepChange={onStepChange}
      />
    );
  }

  if (activeStep === "gap-fill") {
    return (
      <GapFillView
        blocks={blocks}
        onNext={() => onStepChange("gap-detail")}
        onSelectBlock={onSelectBlock}
        onUpdateBlock={onUpdateBlock}
        onStepChange={onStepChange}
        selectedBlockId={selectedBlockId}
      />
    );
  }

  if (activeStep === "gap-detail") {
    return (
      <GapDetailView
        onNext={() => onStepChange("demo")}
        onStepChange={onStepChange}
        selectedBlock={selectedBlock}
      />
    );
  }

  return <DemoView blocks={blocks} onStepChange={onStepChange} />;
};

type HeaderProps = {
  actionLabel?: string;
  activeStep: StepKey;
  onNext?: () => void;
  onStepChange: (step: StepKey) => void;
  subtitle: string;
  title: string;
};

const CanvasTopBar = ({
  actionLabel = "下一步",
  activeStep,
  onNext,
  onStepChange,
  subtitle,
  title
}: HeaderProps) => {
  return (
    <header className="page-header">
      <div className="header-main">
        <div className="brand-block">
          <span className="brand-mark">迁镜</span>
          <div>
            <p>AI 视频结构迁移工作台</p>
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
  const [targetTopic] = useState("宠物用品 / 猫粮"); // Kept for backend call
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

      setPipelineStatus("analyzing");
      setPipelineNote("正在解析样例视频");
      const analysis = await analyzeSampleVideo(uploadedSampleFile.file_id);

      setPipelineStatus("extracting");
      setPipelineNote("正在调用 Mimo 提取结构");
      let usedStructureFallback = false;
      let blueprint: StructureBlueprint;
      try {
        blueprint = await extractStructureBlueprint(analysis, {
          category: toBackendCategory(targetTopic),
          useMock: false,
          vertical: "seeding_de_seeding"
        });
      } catch {
        usedStructureFallback = true;
        blueprint = await extractStructureBlueprint(analysis, {
          category: toBackendCategory(targetTopic),
          useMock: true,
          vertical: "seeding_de_seeding"
        });
      }

      setPipelineStatus("success");
      setPipelineNote(
        usedStructureFallback
          ? "Mimo 返回结构未通过后端 schema 校验，已回退到规则结构。"
          : skippedMaterialCount > 0
          ? `已完成分析；${skippedMaterialCount} 个非视频素材暂未上传到当前后端。`
          : "已完成真实接口分析"
      );
      onWorkflowReady({
        materialFiles: uploadedMaterials.files,
        sampleAnalysis: analysis,
        sampleFile: uploadedSampleFile,
        structureBlueprint: blueprint
      });
      onNext();
    } catch (error) {
      console.warn("Backend unavailable, falling back to UI preview mode.", error);
      setPipelineStatus("success");
      setPipelineNote("（纯UI预览模式）接口连接失败");
      // Set to empty mock data so UI can still render
      onWorkflowReady({
        materialFiles: [],
        sampleAnalysis: undefined,
        sampleFile: undefined,
        structureBlueprint: undefined
      });
      onNext();
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
      shotTitle: slot ? readableSlot({ id: slot.slot_id, label: slot.slot_type, slot, status: "partial", timeRange: formatShotRange(shot) }) : shot.shot_id,
      shotDescription: shot.description,
      migrationPossibility: slot?.migration_rule ?? slot?.content_goal ?? "等待结构提取结果。"
    };
  });
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
  sampleAnalysis,
  sampleFile,
  structureBlueprint
}: {
  onNext: () => void;
  sampleAnalysis?: SampleAnalysis;
  sampleFile?: UploadedVideoFile;
  structureBlueprint?: StructureBlueprint;
}) => {
  const [activeSample, setActiveSample] = useState(2);
  const [extraSamples, setExtraSamples] = useState<ExtraSample[]>([]);
  const addSampleInputRef = useRef<HTMLInputElement>(null);
  const backendRows = sampleAnalysis
    ? buildBackendSampleRows(sampleAnalysis, structureBlueprint)
    : null;
  const sourceLabel = sampleFile?.original_filename ?? "口红广告";

  const baseSampleCount = backendRows ? 1 : 3;

  const handleAddSample = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    Array.from(files).forEach((file, fileIdx) => {
      const newIndex = baseSampleCount + extraSamples.length + fileIdx + 1;
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

    e.target.value = "";
  };

  // Determine which rows to show
  const getActiveRows = (): { rows: SampleAnalysisRow[] | null; loading: boolean; label: string } => {
    if (backendRows && activeSample === 0) {
      return { rows: backendRows, loading: false, label: sourceLabel };
    }
    const extraIdx = activeSample - baseSampleCount - 1;
    if (extraIdx >= 0 && extraIdx < extraSamples.length) {
      const extra = extraSamples[extraIdx];
      return {
        rows: extra.status === "done" ? extra.rows : null,
        loading: extra.status === "loading",
        label: extra.name
      };
    }
    return {
      rows: sampleAnalysisTables[activeSample] ?? sampleAnalysisTables[1],
      loading: false,
      label: sourceLabel
    };
  };

  const active = getActiveRows();

  return (
    <div className="figma-analysis-page">
      <header className="figma-analysis-topbar">
        <div className="figma-analysis-brand">
          <span>迁镜</span>
          <strong>{sourceLabel}</strong>
          <button aria-label="编辑项目名称" className="figma-edit-icon" type="button">
            ✎
          </button>
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
          {(backendRows ? [0] : [1, 2, 3]).map((sampleNumber) => (
            <button
              className={backendRows || sampleNumber === activeSample ? "active" : ""}
              key={sampleNumber}
              onClick={() => setActiveSample(sampleNumber)}
              type="button"
            >
              {backendRows ? "API" : sampleNumber}
            </button>
          ))}
          {extraSamples.map((_, i) => (
            <button
              className={activeSample === baseSampleCount + i + 1 ? "active" : ""}
              key={`extra-${i}`}
              onClick={() => setActiveSample(baseSampleCount + i + 1)}
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
                    <img alt="" src={row.image} />
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
  onNext,
  onUpdateBlock,
  onStepChange
}: {
  blocks: CanvasBlock[];
  materialFiles: UploadedVideoFile[];
  onNext: () => void;
  onUpdateBlock: (updatedBlock: CanvasBlock) => void;
  onStepChange: (step: StepKey) => void;
}) => {
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [ttsStatus, setTtsStatus] = useState<Record<string, "idle" | "loading" | "success">>({});

  const handleTtsGenerate = (blockId: string) => {
    setTtsStatus((prev) => ({ ...prev, [blockId]: "loading" }));
    setTimeout(() => {
      setTtsStatus((prev) => ({ ...prev, [blockId]: "success" }));
    }, 1500);
  };

  return (
    <div className="page-shell migration-page">
      <CanvasTopBar
        activeStep="migration"
        onNext={onNext}
        onStepChange={onStepChange}
        subtitle="把样例结构映射到新素材，人工调整时长和旁白，并生成配音。分镜与状态为只读锁定。"
        title="结构迁移"
      />

      <section className="migration-layout">
        <div className="content-card migration-main">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Mapping</span>
              <h2>迁移矩阵</h2>
            </div>
            <p>点击或编辑任一行以激活选中态，时长与旁白可编辑，其余属性只读锁定。</p>
          </div>
          <div className="table-scroll">
            <table className="data-table migration-table">
              <thead>
                <tr>
                  <th>时长 (可编辑)</th>
                  <th>样例视频</th>
                  <th>分镜描述</th>
                  <th>我的素材</th>
                  <th>旁白 (可编辑)</th>
                  <th>素材状态</th>
                  <th>迁移结果</th>
                </tr>
              </thead>
              <tbody>
                {blocks.map((block, index) => {
                  const isSelected = selectedRowId === block.id;
                  const currentTts = ttsStatus[block.id] ?? "idle";
                  const voiceoverText = block.timeline?.voiceover ?? "";

                  return (
                    <tr
                      key={block.id}
                      className={`migration-row ${isSelected ? "selected-row" : ""}`}
                      onClick={() => setSelectedRowId(block.id)}
                    >
                      {/* 时长: Editable */}
                      <td className="editable-cell">
                        <div className="input-wrapper">
                          <input
                            type="text"
                            className="migration-input duration-input"
                            value={block.timeRange}
                            onChange={(e) => {
                              onUpdateBlock({
                                ...block,
                                timeRange: e.target.value
                              });
                            }}
                            placeholder="e.g. 0-3s"
                          />
                        </div>
                      </td>

                      {/* 样例视频: Readonly */}
                      <td className="readonly-cell">
                        <PlaceholderBlock label={`样例 ${index + 1}`} />
                      </td>

                      {/* 分镜描述: Locked Readonly */}
                      <td className="readonly-cell locked">
                        <div className="readonly-lock-badge">
                          <strong>{readableSlot(block)}</strong>
                          <span className="lock-icon">🔒 只读</span>
                        </div>
                        <span>{readableRule(block)}</span>
                      </td>

                      {/* 我的素材: Readonly */}
                      <td className="readonly-cell">
                        <PlaceholderBlock label={materialFiles[index]?.original_filename ?? `素材 ${index + 1}`} />
                      </td>

                      {/* 旁白: Editable */}
                      <td className="editable-cell voiceover-cell">
                        <div className="voiceover-container">
                          <textarea
                            className="migration-textarea voiceover-textarea"
                            value={voiceoverText}
                            onChange={(e) => {
                              const updatedTimeline = block.timeline
                                ? { ...block.timeline, voiceover: e.target.value }
                                : {
                                    item_id: `tl_${block.id}`,
                                    slot_id: block.id,
                                    time_range: block.timeRange,
                                    slot_type: block.slot.slot_type,
                                    content_goal: block.slot.content_goal,
                                    visual_source: "user_material",
                                    visual_description: "",
                                    subtitle: e.target.value,
                                    voiceover: e.target.value,
                                    transition: "none"
                                  };
                              onUpdateBlock({
                                ...block,
                                timeline: updatedTimeline
                              });
                            }}
                            placeholder="输入旁白文本..."
                            rows={3}
                          />
                          <button
                            type="button"
                            className={`tts-button ${currentTts}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleTtsGenerate(block.id);
                            }}
                            disabled={currentTts === "loading" || !voiceoverText}
                          >
                            {currentTts === "idle" && "生成语音 (TTS)"}
                            {currentTts === "loading" && <span className="spinner">生成中...</span>}
                            {currentTts === "success" && "✓ 语音就绪"}
                          </button>
                        </div>
                      </td>

                      {/* 素材状态: Locked Readonly */}
                      <td className="readonly-cell locked">
                        <div className="status-badge-wrapper">
                          <StatusBadge status={block.status} />
                          <small>{statusTextByStatus[block.status]}</small>
                          <span className="lock-tag">🔒</span>
                        </div>
                      </td>

                      {/* 迁移结果: Readonly */}
                      <td className="readonly-cell">
                        <PlaceholderBlock label={readableSource(block.timeline?.visual_source)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="side-stack">
          <section className="content-card">
            <div className="section-heading compact">
              <div>
                <span className="eyebrow">Blueprint</span>
                <h2>结构蓝图</h2>
              </div>
            </div>
            <div className="slot-list">
              {blocks.map((block) => (
                <div className="slot-item" key={block.id}>
                  <span>{block.timeRange}</span>
                  <strong>{readableSlot(block)}</strong>
                  <StatusBadge status={block.status} />
                </div>
              ))}
            </div>
          </section>

          <section className="content-card">
            <div className="section-heading compact">
              <div>
                <span className="eyebrow">Gaps</span>
                <h2>素材缺口诊断</h2>
              </div>
            </div>
            <div className="gap-summary">
              <MetricCard label="总缺口" value={`${gapReport.summary.total_gaps}`} />
              <MetricCard label="阻塞缺口" value={`${gapReport.summary.blocking_gaps}`} />
            </div>
            <div className="gap-mini-list">
              {gapReport.gaps.map((gap) => (
                <article className="gap-mini-card" key={gap.gap_id}>
                  <span className={`severity-dot ${gap.severity}`} />
                  <strong>{slotLabelByType[gap.slot_type] ?? gap.slot_type}</strong>
                  <p>{readableGapMissing(gap.gap_id, gap.missing)}</p>
                </article>
              ))}
            </div>
          </section>
        </aside>
      </section>
    </div>
  );
};

const GapFillView = ({
  blocks,
  onNext,
  onSelectBlock,
  onUpdateBlock,
  onStepChange,
  selectedBlockId
}: {
  blocks: CanvasBlock[];
  onNext: () => void;
  onSelectBlock: (blockId: string) => void;
  onUpdateBlock: (updatedBlock: CanvasBlock) => void;
  onStepChange: (step: StepKey) => void;
  selectedBlockId: string;
}) => {
  return (
    <div className="page-shell gap-fill-page">
      <CanvasTopBar
        actionLabel="查看缺口"
        activeStep="gap-fill"
        onNext={onNext}
        onStepChange={onStepChange}
        subtitle="每个结构槽位变成一个视频块，红/黄/绿表示匹配状态；只有绿色到绿色的连接为实线。"
        title="缺口补全"
      />
      <section className="gap-fill-layout">
        <VideoBlockCanvas
          blocks={blocks}
          onSelectBlock={onSelectBlock}
          onUpdateBlock={onUpdateBlock}
          selectedBlockId={selectedBlockId}
        />
        <aside className="content-card legend-card">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">Legend</span>
              <h2>匹配状态</h2>
            </div>
          </div>
          <div className="legend-list">
            <span>
              <i className="legend-dot missing" /> 未成功匹配
            </span>
            <span>
              <i className="legend-dot partial" /> 部分匹配
            </span>
            <span>
              <i className="legend-dot matched" /> 已匹配
            </span>
          </div>
          <p>点击视频块查看对应关系和可编辑的补全方式，复杂画布在小屏下会局部横向滚动。</p>
        </aside>
      </section>
    </div>
  );
};

const GapDetailView = ({
  onNext,
  onStepChange,
  selectedBlock
}: {
  onNext: () => void;
  onStepChange: (step: StepKey) => void;
  selectedBlock: CanvasBlock;
}) => {
  const gaps = selectedBlock.gap ? [selectedBlock.gap] : gapReport.gaps;

  return (
    <div className="page-shell gap-detail-page">
      <CanvasTopBar
        actionLabel="进入演示"
        activeStep="gap-detail"
        onNext={onNext}
        onStepChange={onStepChange}
        subtitle="解释缺什么、为什么缺，以及可以通过 AI 生成、包装剪辑或素材复用如何补全。"
        title="缺口详情"
      />

      <section className="gap-detail-layout">
        <aside className="content-card selected-block-card">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">Selected</span>
              <h2>当前视频块</h2>
            </div>
          </div>
          <strong>{readableSlot(selectedBlock)}</strong>
          <p>{readableGoal(selectedBlock)}</p>
          <div className="detail-grid">
            <div>
              <span>时长</span>
              <strong>{selectedBlock.timeRange}</strong>
            </div>
            <div>
              <span>节奏</span>
              <strong>{selectedBlock.slot.rhythm}</strong>
            </div>
            <div>
              <span>状态</span>
              <StatusBadge status={selectedBlock.status} />
            </div>
          </div>
        </aside>

        <div className="gap-card-list">
          {gaps.map((gap) => (
            <section className="content-card gap-detail-card" key={gap.gap_id}>
              <div className="panel-heading">
                <span>{slotLabelByType[gap.slot_type] ?? gap.slot_type}</span>
                <strong>{gap.severity}</strong>
              </div>
              <h2>{readableGapMissing(gap.gap_id, gap.missing)}</h2>
              <p>{readableGapImpact(gap.gap_id, gap.impact)}</p>
              <div className="fill-options">
                {gap.fill_options.map((option) => (
                  <article className="fill-option" key={`${gap.gap_id}-${option.type}`}>
                    <strong>{option.type}</strong>
                    <span>{readableFillOption(option.type, option.description)}</span>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
};

const DemoView = ({
  blocks,
  onStepChange
}: {
  blocks: CanvasBlock[];
  onStepChange: (step: StepKey) => void;
}) => {
  return (
    <div className="page-shell demo-page">
      <CanvasTopBar
        actionLabel="返回编辑"
        activeStep="demo"
        onNext={() => onStepChange("gap-fill")}
        onStepChange={onStepChange}
        subtitle="演示页面保留视频预览、时间线和人工调整入口，渲染与 ASR 暂时作为 mock 展示。"
        title="迁移结果演示"
      />

      <section className="demo-layout">
        <div className="video-preview">
          <div className="preview-canvas">
            <span>新手养猫怎么选猫粮</span>
            <strong>别盲买猫粮</strong>
            <p>结构迁移预览</p>
          </div>
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
          <button className="primary-action full" type="button">
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
