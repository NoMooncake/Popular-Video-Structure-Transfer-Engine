import type { CanvasBlock } from "../types";
import { StatusBadge } from "./StatusBadge";

type VideoBlockCanvasProps = {
  blocks: CanvasBlock[];
  selectedBlockId: string;
  onSelectBlock: (blockId: string) => void;
};

const slotLabelByType: Record<string, string> = {
  risk_or_pain_hook: "风险 Hook",
  pain_desire: "需求拆解",
  product_reveal: "产品露出",
  proof_comparison: "对比证明",
  decision_warning: "避坑提醒",
  cta: "行动引导"
};

const slotGoalByType: Record<string, string> = {
  risk_or_pain_hook: "用风险标题抓住新手养猫用户",
  pain_desire: "说明不同猫咪需求不能跟风选择",
  product_reveal: "按需求展示猫粮选择方向",
  proof_comparison: "用对比卡片解释推荐理由",
  decision_warning: "加入避坑提醒降低盲买风险",
  cta: "引导评论区补充自家猫咪情况"
};

const readableSlot = (block: CanvasBlock) => {
  return slotLabelByType[block.slot.slot_type] ?? block.label;
};

const readableGoal = (block: CanvasBlock) => {
  return slotGoalByType[block.slot.slot_type] ?? block.slot.content_goal;
};

export const VideoBlockCanvas = ({
  blocks,
  selectedBlockId,
  onSelectBlock
}: VideoBlockCanvasProps) => {
  const graphBlocks = blocks.slice(0, 5);

  return (
    <section className="canvas-panel" aria-label="视频块白板">
      <div className="canvas-toolbar">
        <div>
          <h2>视频块白板</h2>
          <p>结构槽位会变成视频块；只有两个已匹配块相连时才显示实线。</p>
        </div>
        <div className="floating-tools" aria-label="画布工具">
          <button type="button">-</button>
          <button type="button">+</button>
          <button className="primary-icon" type="button">▶</button>
          <button type="button">↗</button>
        </div>
      </div>
      <div className="whiteboard graph-board">
        <svg className="graph-connectors" viewBox="0 0 1040 430" aria-hidden="true">
          {graphBlocks.slice(0, -1).map((block, index) => {
            const nextBlock = graphBlocks[index + 1];
            const solid =
              nextBlock && block.status === "matched" && nextBlock.status === "matched";
            const paths = [
              "M 210 205 C 260 205, 285 205, 330 205",
              "M 540 205 C 600 205, 610 110, 665 110",
              "M 540 205 C 600 205, 610 315, 665 315",
              "M 875 110 C 925 110, 930 205, 975 205"
            ];

            return (
              <path
                className={solid ? "graph-line solid" : "graph-line dashed"}
                d={paths[index]}
                key={`${block.id}-${nextBlock?.id}`}
              />
            );
          })}
        </svg>
        {graphBlocks.map((block, index) => {
          const positionClass = `node-${index + 1}`;
          const nextBlock = blocks[index + 1];
          const solidConnector =
            nextBlock && block.status === "matched" && nextBlock.status === "matched";

          return (
            <div className={`graph-node ${positionClass}`} key={block.id}>
              <button
                className={
                  block.id === selectedBlockId
                    ? `video-block ${block.status} selected`
                    : `video-block ${block.status}`
                }
                onClick={() => onSelectBlock(block.id)}
                type="button"
              >
                <span className={`match-strip ${block.status}`} />
                <span className="block-meta">
                  <span className="block-time">{block.timeRange}</span>
                  <StatusBadge status={block.status} />
                </span>
                <strong>{readableSlot(block)}</strong>
                <small>{readableGoal(block)}</small>
              </button>
              <span className={solidConnector ? "node-port solid" : "node-port dashed"} />
            </div>
          );
        })}
      </div>
    </section>
  );
};
