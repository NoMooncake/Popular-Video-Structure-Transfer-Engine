import type { CanvasBlock } from "../types";
import { StatusBadge } from "./StatusBadge";

export const InspectorPanel = ({ block }: { block: CanvasBlock }) => {
  return (
    <aside className="inspector">
      <div className="panel-heading">
        <span>当前视频块</span>
        <StatusBadge status={block.status} />
      </div>
      <h2>{block.slot.slot_type}</h2>
      <p className="muted">{block.slot.content_goal}</p>

      <div className="detail-grid">
        <div>
          <span>时间</span>
          <strong>{block.timeRange}</strong>
        </div>
        <div>
          <span>节奏</span>
          <strong>{block.slot.rhythm}</strong>
        </div>
        <div>
          <span>置信度</span>
          <strong>{Math.round(block.slot.confidence * 100)}%</strong>
        </div>
      </div>

      <section className="inspector-section">
        <h3>如何对应</h3>
        <p>{block.slot.migration_rule}</p>
      </section>

      <section className="inspector-section">
        <h3>需要素材</h3>
        <ul>
          {block.slot.required_materials.map((material) => (
            <li key={material.type}>
              <strong>{material.type}</strong>
              <span>{material.description}</span>
            </li>
          ))}
        </ul>
      </section>

      {block.gap ? (
        <section className="inspector-section warning">
          <h3>缺口</h3>
          <p>{block.gap.missing}</p>
          <small>{block.gap.strategy}</small>
        </section>
      ) : null}

      {block.timeline ? (
        <section className="inspector-section">
          <h3>时间线字幕</h3>
          <p>{block.timeline.subtitle}</p>
        </section>
      ) : null}
    </aside>
  );
};
