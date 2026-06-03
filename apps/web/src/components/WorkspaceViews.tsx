import {
  canvasBlocks,
  gapReport,
  sampleAnalysis,
  timelinePlan
} from "../data/workflow";
import type { CanvasBlock, MatchStatus, StepKey } from "../types";
import { StatusBadge } from "./StatusBadge";
import { VideoBlockCanvas } from "./VideoBlockCanvas";

type WorkspaceViewsProps = {
  activeStep: StepKey;
  onSelectBlock: (blockId: string) => void;
  onStepChange: (step: StepKey) => void;
  selectedBlock: CanvasBlock;
  selectedBlockId: string;
};

const steps: Array<{
  key: StepKey;
  label: string;
  description: string;
}> = [
  {
    key: "input",
    label: "输入",
    description: "样例视频、真实诉求和素材"
  },
  {
    key: "analysis",
    label: "样例解析",
    description: "拆解节奏、分镜和包装"
  },
  {
    key: "migration",
    label: "结构迁移",
    description: "映射新素材和迁移结果"
  },
  {
    key: "gap-fill",
    label: "缺口补全",
    description: "识别红黄绿匹配状态"
  },
  {
    key: "gap-detail",
    label: "缺口详情",
    description: "解释原因和补全方案"
  },
  {
    key: "demo",
    label: "演示",
    description: "时间线预览和人工调整"
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
  cta: "把样例的评论互动结尾迁移为按猫咪情况咨询的 CTA。"
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

export const WorkspaceViews = ({
  activeStep,
  onSelectBlock,
  onStepChange,
  selectedBlock,
  selectedBlockId
}: WorkspaceViewsProps) => {
  if (activeStep === "input") {
    return <InputView onNext={() => onStepChange("analysis")} onStepChange={onStepChange} />;
  }

  if (activeStep === "analysis") {
    return <SampleAnalysisView onNext={() => onStepChange("migration")} onStepChange={onStepChange} />;
  }

  if (activeStep === "migration") {
    return <StructureMigrationView onNext={() => onStepChange("gap-fill")} onStepChange={onStepChange} />;
  }

  if (activeStep === "gap-fill") {
    return (
      <GapFillView
        onNext={() => onStepChange("gap-detail")}
        onSelectBlock={onSelectBlock}
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

  return <DemoView onStepChange={onStepChange} />;
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
  onStepChange
}: {
  onNext: () => void;
  onStepChange: (step: StepKey) => void;
}) => {
  return (
    <div className="page-shell input-page">
      <CanvasTopBar
        activeStep="input"
        onNext={onNext}
        onStepChange={onStepChange}
        subtitle="先把样例、真实需求和可用素材放进同一个工作台，后续分析会基于这些输入生成可解释的结构迁移方案。"
        title="输入素材"
      />

      <section className="hero-panel">
        <div className="hero-copy">
          <span className="eyebrow">Create Brief</span>
          <h2>今天想做什么样的短视频？</h2>
        </div>
        <div className="prompt-box">
          <textarea
            defaultValue="开始一次分镜迁移：我想基于几条爆款样例，生成一条“新手养猫怎么选猫粮”的 20 秒短视频。"
            rows={4}
          />
          <button aria-label="提交需求" onClick={onNext} type="button">
            →
          </button>
        </div>
      </section>

      <section className="input-layout">
        <div className="upload-card-grid">
          <label className="upload-card">
            <input multiple type="file" accept="video/mp4,video/quicktime,video/webm" />
            <span className="upload-icon">01</span>
            <strong>上传样例视频</strong>
            <span>支持多条样例，用来学习 Hook、节奏、包装和 CTA。</span>
          </label>
          <label className="upload-card">
            <input multiple type="file" accept="image/*,video/*,.txt,.md" />
            <span className="upload-icon">02</span>
            <strong>上传真实素材</strong>
            <span>上传图片、视频片段、产品文案和案例素材。</span>
          </label>
        </div>

        <section className="work-panel brief-panel">
          <div className="panel-heading">
            <span>真实诉求和目标案例</span>
            <strong>可编辑</strong>
          </div>
          <textarea
            defaultValue="新手养猫怎么选猫粮：不同猫咪需求对应不同猫粮，不要盲买。"
            rows={5}
          />
          <div className="field-row">
            <input defaultValue="宠物用品 / 猫粮" />
            <input defaultValue="目标时长：20 秒" />
          </div>
        </section>
      </section>
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

const SampleAnalysisView = ({
  onNext,
  onStepChange
}: {
  onNext: () => void;
  onStepChange: (step: StepKey) => void;
}) => {
  return (
    <div className="page-shell analysis-page">
      <CanvasTopBar
        activeStep="analysis"
        onNext={onNext}
        onStepChange={onStepChange}
        subtitle="参考 Figma 的样例解析页面，但改成 Web 端可伸缩表格、关键帧横向卡片和稳定的内容容器。"
        title="样例解析"
      />

      <section className="summary-grid">
        <MetricCard label="样例时长" value="240s" />
        <MetricCard label="关键帧" value={`${sampleAnalysis.keyframes.length} 帧`} />
        <MetricCard label="结构槽位" value={`${canvasBlocks.length} 个`} />
        <MetricCard label="包装密度" value="高字幕 / 快节奏" />
      </section>

      <section className="content-card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Keyframes</span>
            <h2>关键帧展示</h2>
          </div>
          <p>小屏不压缩画面，使用局部横向滚动。</p>
        </div>
        <div className="keyframe-strip">
          {sampleAnalysis.keyframes.map((keyframe, index) => (
            <article className="keyframe-card" key={keyframe.frame_id}>
              <div className="phone-frame">
                <span>KF {String(index + 1).padStart(2, "0")}</span>
              </div>
              <strong>{keyframe.time_seconds}s</strong>
              <p>{["风险标题", "需求标签", "产品卡片", "成分说明", "对比标准", "评论引导"][index] ?? "关键画面"}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="content-card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Structure</span>
            <h2>AI 拆解结构</h2>
          </div>
          <p>保留 Figma 表格的内容形式，Web 端通过局部滚动保证列宽稳定。</p>
        </div>
        <div className="table-scroll">
          <table className="data-table analysis-table">
            <thead>
              <tr>
                <th>结构段落</th>
                <th>样例视频</th>
                <th>分镜描述</th>
                <th>我的素材</th>
                <th>素材状态</th>
                <th>迁移结果</th>
              </tr>
            </thead>
            <tbody>
              {canvasBlocks.slice(0, 5).map((block, index) => (
                <tr key={block.id}>
                  <td>
                    <strong>{readableSlot(block)}</strong>
                    <span>{block.timeRange}</span>
                  </td>
                  <td>
                    <PlaceholderBlock label={`样例 ${index + 1}`} />
                  </td>
                  <td>{readableGoal(block)}</td>
                  <td>
                    <PlaceholderBlock label={`素材 ${index + 1}`} />
                  </td>
                  <td>
                    <StatusBadge status={block.status} />
                  </td>
                  <td>
                    <PlaceholderBlock label={readableSource(block.timeline?.visual_source)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

const StructureMigrationView = ({
  onNext,
  onStepChange
}: {
  onNext: () => void;
  onStepChange: (step: StepKey) => void;
}) => {
  return (
    <div className="page-shell migration-page">
      <CanvasTopBar
        activeStep="migration"
        onNext={onNext}
        onStepChange={onStepChange}
        subtitle="把样例结构映射到新素材，明确哪些槽位已匹配、部分匹配或需要 AI/剪辑补全。"
        title="结构迁移"
      />

      <section className="migration-layout">
        <div className="content-card migration-main">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Mapping</span>
              <h2>迁移矩阵</h2>
            </div>
            <p>表格列宽固定在局部滚动区域内，避免小屏被压扁。</p>
          </div>
          <div className="table-scroll">
            <table className="data-table migration-table">
              <thead>
                <tr>
                  <th>时长</th>
                  <th>样例视频</th>
                  <th>分镜描述</th>
                  <th>我的素材</th>
                  <th>素材状态</th>
                  <th>迁移结果</th>
                </tr>
              </thead>
              <tbody>
                {canvasBlocks.map((block, index) => (
                  <tr key={block.id}>
                    <td>{block.timeRange}</td>
                    <td>
                      <PlaceholderBlock label={`样例 ${index + 1}`} />
                    </td>
                    <td>
                      <strong>{readableSlot(block)}</strong>
                      <span>{readableRule(block)}</span>
                    </td>
                    <td>
                      <PlaceholderBlock label={`素材 ${index + 1}`} />
                    </td>
                    <td>
                      <StatusBadge status={block.status} />
                      <small>{statusTextByStatus[block.status]}</small>
                    </td>
                    <td>
                      <PlaceholderBlock label={readableSource(block.timeline?.visual_source)} />
                    </td>
                  </tr>
                ))}
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
              {canvasBlocks.map((block) => (
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
  onNext,
  onSelectBlock,
  onStepChange,
  selectedBlockId
}: {
  onNext: () => void;
  onSelectBlock: (blockId: string) => void;
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
          blocks={canvasBlocks}
          onSelectBlock={onSelectBlock}
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

const DemoView = ({ onStepChange }: { onStepChange: (step: StepKey) => void }) => {
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
            <p>20 秒结构迁移预览</p>
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
          <p>{timelinePlan.target_video.duration_seconds}s · 9:16 · 可横向浏览</p>
        </div>
        <div className="timeline-strip">
          {timelinePlan.timeline.map((item, index) => (
            <button className="timeline-item" key={item.item_id} type="button">
              <span>{item.time_range}</span>
              <strong>{slotLabelByType[item.slot_type] ?? `分镜 ${index + 1}`}</strong>
              <small>{readableSource(item.visual_source)}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
};
