import type { CanvasBlock } from "../types";
import { StatusBadge } from "./StatusBadge";

type VideoBlockCanvasProps = {
  blocks: CanvasBlock[];
  selectedBlockId: string;
  onSelectBlock: (blockId: string) => void;
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
          <h2>缺口补全白板</h2>
          <p>结构槽位会变成视频块；只有两个已匹配块相连时才显示实线</p>
        </div>
        <div className="floating-tools" aria-label="画布工具">
          <button type="button">＋</button>
          <button type="button">文</button>
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
                <strong>{block.slot.content_goal}</strong>
                <small>{block.slot.migration_rule}</small>
              </button>
              <span className={solidConnector ? "node-port solid" : "node-port dashed"} />
            </div>
          );
        })}
      </div>
    </section>
  );
};
