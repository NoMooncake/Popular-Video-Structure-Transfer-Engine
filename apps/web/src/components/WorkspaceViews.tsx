import {
  canvasBlocks,
  gapReport,
  sampleAnalysis,
  structureBlueprint,
  timelinePlan
} from "../data/workflow";
import type { CanvasBlock, StepKey } from "../types";
import { StatusBadge } from "./StatusBadge";

type WorkspaceViewsProps = {
  activeStep: StepKey;
  selectedBlock: CanvasBlock;
};

export const WorkspaceViews = ({ activeStep, selectedBlock }: WorkspaceViewsProps) => {
  if (activeStep === "input") {
    return <InputView />;
  }

  if (activeStep === "analysis") {
    return <AnalysisView />;
  }

  if (activeStep === "gap-fill") {
    return <GapFillView />;
  }

  if (activeStep === "gap-detail") {
    return <GapDetailView selectedBlock={selectedBlock} />;
  }

  return <DemoView />;
};

const InputView = () => {
  return (
    <div className="input-screen">
      <section className="prompt-panel">
        <h2>今天想做个什么样的视频？</h2>
        <div className="prompt-box">
          <textarea
            defaultValue="开始一次分镜迁移吧：我想基于几条爆款样例，生成一条新手养猫怎么选猫粮的 20 秒短视频。"
            rows={3}
          />
          <button aria-label="提交需求" type="button">
            ↑
          </button>
        </div>
      </section>

      <section className="upload-card-grid">
        <label className="upload-card">
          <input multiple type="file" accept="video/mp4,video/quicktime,video/webm" />
          <strong>上传样例视频</strong>
          <span>支持多条样例，用来学习 Hook、节奏、包装和 CTA</span>
        </label>
        <label className="upload-card">
          <input multiple type="file" accept="image/*,video/*,.txt,.md" />
          <strong>上传真实素材</strong>
          <span>上传图片、视频片段、产品文案、案例素材</span>
        </label>
      </section>

      <section className="work-panel brief-panel">
        <h3>真实诉求和目标案例</h3>
        <textarea
          defaultValue="新手养猫怎么选猫粮：不同猫咪需求对应不同猫粮，不要盲买。"
          rows={4}
        />
        <div className="field-row">
          <input defaultValue="宠物用品 / 猫粮" />
          <input defaultValue="目标时长：20 秒" />
        </div>
      </section>
    </div>
  );
};

const AnalysisView = () => {
  return (
    <div className="view-stack">
      <section className="work-panel">
        <div className="panel-heading">
          <span>样例解析2</span>
          <strong>{structureBlueprint.slots.length} 个结构槽位</strong>
        </div>
        <h2>{structureBlueprint.summary}</h2>
        <p className="muted">
          这里把样例拆成 Hook、需求、产品展示、对比证明、决策提醒和 CTA，后续会接真实
          ASR 与多模态分析。
        </p>
      </section>

      <AnalysisMatrix />
    </div>
  );
};

const AnalysisMatrix = () => {
  return (
    <section className="analysis-matrix" aria-label="样例解析表格">
      <div className="matrix-header">
        <span>时长</span>
        <span>样例视频</span>
        <span>分镜描述</span>
        <span>我的素材</span>
        <span>素材状态</span>
        <span>迁移结果</span>
      </div>
      {canvasBlocks.slice(0, 4).map((block, index) => {
        const keyframe = sampleAnalysis.keyframes[index];
        const statusText =
          block.status === "matched"
            ? "已匹配"
            : block.status === "partial"
              ? "待确认"
              : "未匹配";

        return (
          <div className="matrix-row" key={block.id}>
            <div className="matrix-time">{block.timeRange}</div>
            <div className="matrix-media">
              <div className="media-tile">样例 {keyframe?.frame_id ?? index + 1}</div>
            </div>
            <div className="matrix-copy">
              <strong>{block.slot.slot_type}</strong>
              <span>{block.slot.content_goal}</span>
            </div>
            <div className="matrix-media">
              <div className="media-tile muted-tile">素材 {index + 1}</div>
            </div>
            <div className="matrix-status">
              <StatusBadge status={block.status} />
              <span>{statusText}</span>
            </div>
            <div className="matrix-media">
              <div className="media-tile result-tile">{block.timeline?.visual_source}</div>
            </div>
          </div>
        );
      })}
    </section>
  );
};

const GapFillView = () => {
  return (
    <div className="view-stack">
      <section className="work-panel">
        <div className="panel-heading">
          <span>缺口补全</span>
          <strong>{gapReport.summary.overall_status}</strong>
        </div>
        <h2>{gapReport.summary.notes}</h2>
        <div className="status-legend">
          <StatusBadge status="missing" />
          <StatusBadge status="partial" />
          <StatusBadge status="matched" />
        </div>
      </section>

      <div className="block-list">
        {canvasBlocks.map((block) => (
          <article className="work-panel compact" key={block.id}>
            <div className="panel-heading">
              <span>{block.timeRange}</span>
              <StatusBadge status={block.status} />
            </div>
            <h3>{block.slot.slot_type}</h3>
            <p>{block.gap?.strategy ?? "素材可直接承接该结构槽位。"}</p>
          </article>
        ))}
      </div>
    </div>
  );
};

const GapDetailView = ({ selectedBlock }: { selectedBlock: CanvasBlock }) => {
  const gaps = selectedBlock.gap ? [selectedBlock.gap] : gapReport.gaps;

  return (
    <div className="view-stack">
      <section className="work-panel">
        <div className="panel-heading">
          <span>缺口详情</span>
          <strong>{gaps.length} 项</strong>
        </div>
        <h2>解释缺什么、为什么缺、如何补</h2>
      </section>

      {gaps.map((gap) => (
        <section className="work-panel" key={gap.gap_id}>
          <div className="panel-heading">
            <span>{gap.slot_type}</span>
            <strong>{gap.severity}</strong>
          </div>
          <h3>{gap.missing}</h3>
          <p>{gap.impact}</p>
          <div className="fill-options">
            {gap.fill_options.map((option) => (
              <div className="fill-option" key={`${gap.gap_id}-${option.type}`}>
                <strong>{option.type}</strong>
                <span>{option.description}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
};

const DemoView = () => {
  return (
    <div className="demo-stage">
      <section className="video-preview">
        <button aria-label="关闭演示" className="close-preview" type="button">
          ×
        </button>
        <div className="preview-canvas">
          <span>{timelinePlan.script.title}</span>
          <strong>别盲买猫粮</strong>
          <p>{timelinePlan.timeline[0]?.subtitle}</p>
        </div>
        <div className="scrubber">
          <span />
        </div>
      </section>
      <section className="work-panel">
        <div className="panel-heading">
          <span>时间线展示</span>
          <strong>{timelinePlan.target_video.duration_seconds}s</strong>
        </div>
        <h2>{timelinePlan.script.summary}</h2>
        <div className="timeline-strip">
          {timelinePlan.timeline.map((item) => (
            <button className="timeline-item" key={item.item_id} type="button">
              <span>{item.time_range}</span>
              <strong>{item.subtitle}</strong>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
};
