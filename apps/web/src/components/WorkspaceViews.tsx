import {
  canvasBlocks,
  gapReport,
  sampleAnalysis,
  structureBlueprint,
  timelinePlan
} from "../data/workflow";
import type { CanvasBlock, StepKey } from "../types";
import { StatusBadge } from "./StatusBadge";
import { VideoBlockCanvas } from "./VideoBlockCanvas";

type WorkspaceViewsProps = {
  activeStep: StepKey;
  onSelectBlock: (blockId: string) => void;
  onStepChange: (step: StepKey) => void;
  selectedBlock: CanvasBlock;
  selectedBlockId: string;
};

export const WorkspaceViews = ({
  activeStep,
  onSelectBlock,
  onStepChange,
  selectedBlock,
  selectedBlockId
}: WorkspaceViewsProps) => {
  if (activeStep === "input") {
    return <InputView onNext={() => onStepChange("analysis")} />;
  }

  if (activeStep === "analysis") {
    return <SampleAnalysisView onNext={() => onStepChange("migration")} />;
  }

  if (activeStep === "migration") {
    return <StructureMigrationView onNext={() => onStepChange("gap-fill")} />;
  }

  if (activeStep === "gap-fill") {
    return (
      <GapFillView
        onNext={() => onStepChange("gap-detail")}
        onSelectBlock={onSelectBlock}
        selectedBlockId={selectedBlockId}
      />
    );
  }

  if (activeStep === "gap-detail") {
    return <GapDetailView onNext={() => onStepChange("demo")} selectedBlock={selectedBlock} />;
  }

  return <DemoView />;
};

const InputView = ({ onNext }: { onNext: () => void }) => {
  return (
    <div className="figma-frame input-frame">
      <CanvasTopBar actionLabel="下一步" onNext={onNext} />
      <section className="prompt-panel">
        <h2>今天想做个什么样的视频？</h2>
        <div className="prompt-box">
          <textarea
            defaultValue="开始一次分镜迁移吧：我想基于几条爆款样例，生成一条新手养猫怎么选猫粮的 20 秒短视频。"
            rows={3}
          />
          <button aria-label="提交需求" onClick={onNext} type="button">
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

const analysisRows = [
  {
    time: "0 - 2s",
    segment: "Hook",
    shot: "口播镜头",
    status: "已匹配"
  },
  {
    time: "2 - 5s",
    segment: "Hook",
    shot: "口播镜头",
    status: "待补全，对比图不足"
  },
  {
    time: "5 - 10s",
    segment: "Hook",
    shot: "口播镜头",
    status: "已匹配"
  },
  {
    time: "10 - 15s",
    segment: "Hook",
    shot: "口播镜头",
    status: "已匹配"
  }
];

const migrationRows = [
  {
    time: "0 - 2s",
    title: "Hook",
    desc: "口播视频",
    status: "已匹配"
  },
  {
    time: "2 - 5s",
    title: "Introduction",
    desc: "产品展示",
    status: "未匹配"
  },
  {
    time: "5 - 10s",
    title: "Usage",
    desc: "操作演示",
    status: "已匹配"
  },
  {
    time: "10 - 15s",
    title: "Call to Action",
    desc: "购买引导",
    status: "待确认"
  }
];

const CanvasTopBar = ({
  actionLabel = "下一步",
  onNext
}: {
  actionLabel?: string;
  onNext?: () => void;
}) => {
  return (
    <div className="figma-topbar">
      <div className="figma-brand">
        <span>迁镜</span>
        <strong>未命名画布</strong>
        <em>↗</em>
      </div>
      <div className="figma-avatar">CY</div>
      <button className="figma-next" onClick={onNext} type="button">
        {actionLabel}
      </button>
    </div>
  );
};

const SampleAnalysisView = ({ onNext }: { onNext: () => void }) => {
  return (
    <div className="figma-frame sample-analysis-frame">
      <CanvasTopBar onNext={onNext} />
      <div className="sample-table-head">
        <span>结构段落</span>
        <span>样例视频</span>
        <span>分镜描述</span>
        <span>我的素材</span>
        <span>素材状态</span>
        <span>迁移结果</span>
      </div>
      <div className="sample-grid">
        {analysisRows.map((row, index) => (
          <div className="sample-row" key={`${row.time}-${index}`}>
            <div className="sample-segment-card">{row.segment}</div>
            <div className="figma-media-card light" />
            <div className="figma-copy-card">
              <span>{row.shot}</span>
            </div>
            <div className="figma-media-card light" />
            <div className="figma-copy-card">
              <span>{row.status}</span>
            </div>
            <div className="figma-media-card light" />
          </div>
        ))}
      </div>
    </div>
  );
};

const StructureMigrationView = ({ onNext }: { onNext: () => void }) => {
  return (
    <div className="figma-frame migration-frame">
      <CanvasTopBar onNext={onNext} />
      <section className="migration-table" aria-label="结构迁移矩阵">
        <div className="migration-header">
          <span>时长</span>
          <span>样例视频</span>
          <span>分镜描述</span>
          <span>我的素材</span>
          <span>素材状态</span>
          <span>迁移结果</span>
        </div>
        {migrationRows.map((row, index) => (
          <div className="migration-row" key={row.time}>
            <div className="migration-time">{row.time}</div>
            <div className="migration-cell">
              <div className="figma-media-card light" />
            </div>
            <div className="migration-copy">
              <strong>{row.title}</strong>
              <span>{row.desc}</span>
            </div>
            <div className="migration-cell">
              <div className="figma-media-card light" />
            </div>
            <div className="migration-status">{row.status}</div>
            <div className="migration-cell">
              <div className="figma-media-card light" />
            </div>
          </div>
        ))}
      </section>
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

const GapFillView = ({
  onNext,
  onSelectBlock,
  selectedBlockId
}: {
  onNext: () => void;
  onSelectBlock: (blockId: string) => void;
  selectedBlockId: string;
}) => {
  return (
    <div className="figma-frame gap-fill-frame">
      <CanvasTopBar actionLabel="生成" onNext={onNext} />
      <VideoBlockCanvas
        blocks={canvasBlocks}
        onSelectBlock={onSelectBlock}
        selectedBlockId={selectedBlockId}
      />
    </div>
  );
};

const GapDetailView = ({
  onNext,
  selectedBlock
}: {
  onNext: () => void;
  selectedBlock: CanvasBlock;
}) => {
  const gaps = selectedBlock.gap ? [selectedBlock.gap] : gapReport.gaps;

  return (
    <div className="figma-frame gap-detail-frame">
      <CanvasTopBar actionLabel="生成" onNext={onNext} />
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
