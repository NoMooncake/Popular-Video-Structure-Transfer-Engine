import { useState, useRef, useEffect } from "react";
import type { CanvasBlock, MatchStatus } from "../types";
import { StatusBadge } from "./StatusBadge";

type VideoBlockCanvasProps = {
  blocks: CanvasBlock[];
  selectedBlockId: string;
  onSelectBlock: (blockId: string) => void;
  onUpdateBlock: (updatedBlock: CanvasBlock) => void;
};

// Initial coordinates for structure cards
const initialPositions: Record<string, { x: number; y: number }> = {
  slot_01: { x: 50, y: 150 },
  slot_02: { x: 340, y: 150 },
  slot_03: { x: 630, y: 40 },
  slot_04: { x: 630, y: 260 },
  slot_05: { x: 920, y: 150 },
  slot_06: { x: 1210, y: 150 },

  // Supplement card offsets (will spawn dynamically near structure slots)
  supp_slot_01: { x: 50, y: 360 },
  supp_slot_04: { x: 630, y: 470 },
  supp_slot_06: { x: 1210, y: 360 }
};

// Mock generated image variants (2x2 grid)
const mockAiImages = [
  "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?auto=format&fit=crop&w=400&q=80",
  "https://images.unsplash.com/photo-1533738363-b7f9aef128ce?auto=format&fit=crop&w=400&q=80",
  "https://images.unsplash.com/photo-1573865526739-10659fec78a5?auto=format&fit=crop&w=400&q=80",
  "https://images.unsplash.com/photo-1543466835-00a7907e9de1?auto=format&fit=crop&w=400&q=80"
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
  onSelectBlock,
  onUpdateBlock
}: VideoBlockCanvasProps) => {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(initialPositions);
  const [isDragging, setIsDragging] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  // Spawning / Connection state for supplement cards
  const [connectedSupplements, setConnectedSupplements] = useState<Record<string, boolean>>({
    slot_01: false,
    slot_04: false,
    slot_06: false
  });

  // AI image selected for each slot
  const [aiImages, setAiImages] = useState<Record<string, string | null>>({
    slot_01: null,
    slot_04: null,
    slot_06: null
  });

  // AI Generation Loading State
  const [generatingSlotId, setGeneratingSlotId] = useState<string | null>(null);
  const [showAiSelector, setShowAiSelector] = useState(false);

  // Dragging state references
  const dragRef = useRef<{
    draggedId: string;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
  } | null>(null);

  const selectedBlock = blocks.find((b) => b.id === selectedBlockId) ?? blocks[0];

  const handlePointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    onSelectBlock(id.replace("supp_", "")); // select the base block
    const pos = positions[id] || { x: 0, y: 0 };
    dragRef.current = {
      draggedId: id,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: pos.x,
      startTop: pos.y
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const { draggedId, startX, startY, startLeft, startTop } = dragRef.current;
    
    // Set dragging state to hide SVG paths for performance
    if (!isDragging) {
      setIsDragging(true);
    }

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    setPositions((prev) => ({
      ...prev,
      [draggedId]: {
        x: Math.max(0, startLeft + dx),
        y: Math.max(0, startTop + dy)
      }
    }));
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
    setIsDragging(false);
  };

  // Helper to compute SVG connection lines
  const getTimelinePath = (fromId: string, toId: string) => {
    const fromPos = positions[fromId];
    const toPos = positions[toId];
    if (!fromPos || !toPos) return "";
    const x1 = fromPos.x + 240;
    const y1 = fromPos.y + 80;
    const x2 = toPos.x;
    const y2 = toPos.y + 80;
    const dx = x2 - x1;
    return `M ${x1} ${y1} C ${x1 + dx / 2} ${y1}, ${x2 - dx / 2} ${y2}, ${x2} ${y2}`;
  };

  const getMaterialPath = (suppId: string, structId: string) => {
    const suppPos = positions[suppId];
    const structPos = positions[structId];
    if (!suppPos || !structPos) return "";
    const x1 = suppPos.x + 120;
    const y1 = suppPos.y;
    const x2 = structPos.x + 120;
    const y2 = structPos.y + 160;
    const dy = y1 - y2;
    return `M ${x1} ${y1} C ${x1} ${y1 - dy / 2}, ${x2} ${y2 + dy / 2}, ${x2} ${y2}`;
  };

  // Check if timeline connections should be solid
  const isSolidTimeline = (fromId: string, toId: string) => {
    const fromBlock = blocks.find((b) => b.id === fromId);
    const toBlock = blocks.find((b) => b.id === toId);
    return fromBlock?.status === "matched" && toBlock?.status === "matched";
  };

  // Trigger simulated AI generation
  const handleTriggerAiGeneration = (slotId: string) => {
    setGeneratingSlotId(slotId);
    setTimeout(() => {
      setGeneratingSlotId(null);
      setShowAiSelector(true);
    }, 1200);
  };

  const handleSelectAiImage = (imageUrl: string) => {
    if (!selectedBlock) return;
    const blockId = selectedBlock.id;
    setAiImages((prev) => ({ ...prev, [blockId]: imageUrl }));
    setShowAiSelector(false);

    // Update block state to matched
    onUpdateBlock({
      ...selectedBlock,
      status: "matched",
      timeline: selectedBlock.timeline
        ? {
            ...selectedBlock.timeline,
            visual_source: "generated_graphic",
            visual_description: `AI生成的图片: ${selectedBlock.gap?.missing || "补全素材"}`
          }
        : undefined
    });
  };

  const toggleConnectSupplement = (slotId: string) => {
    setConnectedSupplements((prev) => ({
      ...prev,
      [slotId]: !prev[slotId]
    }));
  };

  return (
    <section className="canvas-panel" aria-label="视频块白板">
      <div className="canvas-toolbar">
        <div>
          <h2>ShotSwift 白板画布</h2>
          <p>拖拽视频块调整布局。选择缺失或部分匹配的卡片进行素材补全与 AI 生成。</p>
        </div>
        <div className="floating-tools" aria-label="画布工具">
          <button type="button" onClick={() => setPositions(initialPositions)} title="重置布局">↺ 重置</button>
          <button type="button" onClick={() => setShowHelp(true)}>帮助 ?</button>
        </div>
      </div>

      <div className="whiteboard-wrapper" style={{ position: "relative" }}>
        <div className="whiteboard graph-board" style={{ height: "640px", overflow: "auto" }}>
          {/* SVG Connector Lines */}
          {!isDragging && (
            <svg className="graph-connectors" style={{ width: "1600px", height: "600px", position: "absolute", pointerEvents: "none" }} aria-hidden="true">
              {/* Timeline Sequence Connections */}
              <path
                className={isSolidTimeline("slot_01", "slot_02") ? "graph-line solid" : "graph-line dashed"}
                d={getTimelinePath("slot_01", "slot_02")}
              />
              <path
                className={isSolidTimeline("slot_02", "slot_03") ? "graph-line solid" : "graph-line dashed"}
                d={getTimelinePath("slot_02", "slot_03")}
              />
              <path
                className={isSolidTimeline("slot_02", "slot_04") ? "graph-line solid" : "graph-line dashed"}
                d={getTimelinePath("slot_02", "slot_04")}
              />
              <path
                className={isSolidTimeline("slot_03", "slot_05") ? "graph-line solid" : "graph-line dashed"}
                d={getTimelinePath("slot_03", "slot_05")}
              />
              <path
                className={isSolidTimeline("slot_04", "slot_05") ? "graph-line solid" : "graph-line dashed"}
                d={getTimelinePath("slot_04", "slot_05")}
              />
              <path
                className={isSolidTimeline("slot_05", "slot_06") ? "graph-line solid" : "graph-line dashed"}
                d={getTimelinePath("slot_05", "slot_06")}
              />

              {/* Material Supplement Connections */}
              {connectedSupplements.slot_01 && (
                <path
                  className={selectedBlock.status === "matched" ? "graph-line solid" : "graph-line dashed"}
                  d={getMaterialPath("supp_slot_01", "slot_01")}
                />
              )}
              {connectedSupplements.slot_04 && (
                <path
                  className={selectedBlock.status === "matched" ? "graph-line solid" : "graph-line dashed"}
                  d={getMaterialPath("supp_slot_04", "slot_04")}
                />
              )}
              {connectedSupplements.slot_06 && (
                <path
                  className={selectedBlock.status === "matched" ? "graph-line solid" : "graph-line dashed"}
                  d={getMaterialPath("supp_slot_06", "slot_06")}
                />
              )}
            </svg>
          )}

          {/* Render Structure Slot Cards */}
          {blocks.map((block) => {
            const pos = positions[block.id] || { x: 0, y: 0 };
            const isSelected = selectedBlockId === block.id;

            return (
              <div
                key={block.id}
                className="graph-node"
                style={{
                  transform: `translate(${pos.x}px, ${pos.y}px)`,
                  position: "absolute",
                  transition: isDragging ? "none" : "transform 0.1s ease"
                }}
              >
                <div
                  className={`video-block ${block.status} ${isSelected ? "selected" : ""}`}
                  onPointerDown={(e) => handlePointerDown(e, block.id)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  style={{ touchAction: "none" }}
                >
                  <span className={`match-strip ${block.status}`} />
                  <span className="block-meta">
                    <span className="block-time">{block.timeRange}</span>
                    <StatusBadge status={block.status} />
                  </span>
                  <strong>{readableSlot(block)}</strong>
                  <small>{readableGoal(block)}</small>

                  {/* Left Timeline Port */}
                  <span className="node-port left-port" />
                  
                  {/* Right Timeline Port */}
                  <span className="node-port right-port" />

                  {/* Bottom Input Port - visible when selected */}
                  {isSelected && <span className="node-port bottom-port" />}
                </div>
              </div>
            );
          })}

          {/* Render Spawning Supplement Cards */}
          {blocks.map((block) => {
            if (!connectedSupplements[block.id]) return null;
            const suppId = `supp_${block.id}`;
            const pos = positions[suppId] || { x: 0, y: 0 };
            const isSelected = selectedBlockId === block.id;
            const customImage = aiImages[block.id];

            return (
              <div
                key={suppId}
                className="graph-node supplement-node"
                style={{
                  transform: `translate(${pos.x}px, ${pos.y}px)`,
                  position: "absolute",
                  transition: isDragging ? "none" : "transform 0.1s ease"
                }}
              >
                <div
                  className={`video-block supplement-card ${isSelected ? "selected" : ""}`}
                  onPointerDown={(e) => handlePointerDown(e, suppId)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  style={{
                    touchAction: "none",
                    background: "#222222",
                    border: "1px dashed var(--text-muted)",
                    color: "var(--text)"
                  }}
                >
                  <span className="match-strip partial" style={{ background: "var(--theme)" }} />
                  <span className="block-meta">
                    <span className="block-time">素材补全</span>
                    <span className="supplement-tag">补充卡片</span>
                  </span>
                  
                  <div className="supplement-body" style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
                    {customImage ? (
                      <img src={customImage} alt="AI Generated" style={{ width: "64px", height: "64px", borderRadius: "4px", objectFit: "cover" }} />
                    ) : (
                      <div className="media-placeholder" style={{ width: "64px", height: "64px", minWidth: "64px", minHeight: "64px", fontSize: "10px" }}>待生成</div>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
                      <strong style={{ fontSize: "12px", color: "var(--text-strong)" }}>{block.gap?.missing || "图片素材"}</strong>
                      <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>{block.gap?.strategy || "使用AI包装生成"}</span>
                    </div>
                  </div>

                  {/* Top Output Port */}
                  <span className="node-port top-port" />
                </div>
              </div>
            );
          })}
        </div>

        {/* Floating Question Legend Overlay */}
        {showHelp && (
          <div className="legend-overlay" style={{
            position: "absolute",
            bottom: "20px",
            left: "20px",
            background: "var(--panel)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius)",
            padding: "16px",
            zIndex: 10,
            maxWidth: "320px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)"
          }}>
            <h3 style={{ margin: "0 0 10px", color: "var(--text-strong)" }}>画布图例说明</h3>
            <div className="legend-list" style={{ gap: "8px", fontSize: "13px" }}>
              <span><i className="legend-dot matched" /> 已匹配 (Matched) - 状态完备，不可编辑</span>
              <span><i className="legend-dot partial" /> 部分匹配 (Partial) - 建议包装补全</span>
              <span><i className="legend-dot missing" /> 未匹配 (Missing) - 完全缺失，建议AI生成</span>
              <hr style={{ border: "0", borderTop: "1px solid var(--line)", margin: "8px 0" }} />
              <span>─── 实线: 绿-绿连接 (时间线顺畅)</span>
              <span>- - - 虚线: 缺口连接 (包含缺失/部分匹配块)</span>
            </div>
            <button
              type="button"
              className="primary-action"
              style={{ minHeight: "30px", marginTop: "12px", width: "100%" }}
              onClick={() => setShowHelp(false)}
            >
              关闭
            </button>
          </div>
        )}

        {/* Floating Question mark trigger button on bottom-left */}
        {!showHelp && (
          <button
            type="button"
            className="help-trigger-btn"
            onClick={() => setShowHelp(true)}
            style={{
              position: "absolute",
              bottom: "20px",
              left: "20px",
              width: "36px",
              height: "36px",
              borderRadius: "999px",
              background: "var(--panel-soft)",
              border: "1px solid var(--line)",
              color: "var(--text)",
              fontWeight: "bold",
              fontSize: "18px",
              cursor: "pointer",
              zIndex: 9
            }}
          >
            ?
          </button>
        )}
      </div>

      {/* Dynamic Editing Panel below or beside */}
      {selectedBlock && (
        <div className="content-card editing-detail-panel" style={{ marginTop: "18px" }}>
          <div className="section-heading" style={{ marginBottom: "12px" }}>
            <div>
              <span className="eyebrow">{readableSlot(selectedBlock)}</span>
              <h2>{selectedBlock.status === "matched" ? "🔒 结构块已锁定" : "🛠️ 补全详情编辑"}</h2>
            </div>
            <StatusBadge status={selectedBlock.status} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: "20px" }}>
            <div>
              <p style={{ color: "var(--text-muted)", fontSize: "13px", marginBottom: "8px" }}>
                <strong>目标: </strong>{readableGoal(selectedBlock)}
              </p>
              {selectedBlock.gap ? (
                <div style={{ background: "rgba(0,0,0,0.15)", padding: "10px", borderRadius: "var(--radius)" }}>
                  <h4 style={{ color: "var(--theme)", margin: "0 0 4px", fontSize: "13px" }}>⚠️ 素材缺口: {selectedBlock.gap.missing}</h4>
                  <p style={{ margin: "0", fontSize: "12px", color: "var(--text-muted)" }}>{selectedBlock.gap.impact}</p>
                </div>
              ) : (
                <div style={{ background: "rgba(52, 183, 122, 0.1)", padding: "10px", borderRadius: "var(--radius)", color: "var(--matched)", fontSize: "13px" }}>
                  ✓ 状态完备。已成功对接对应素材，锁定编辑。
                </div>
              )}
            </div>

            {selectedBlock.gap && (
              <div style={{ borderLeft: "1px solid var(--line)", paddingLeft: "20px" }}>
                <div style={{ display: "flex", gap: "10px", marginBottom: "12px" }}>
                  <button
                    type="button"
                    className={`primary-action ${connectedSupplements[selectedBlock.id] ? "active-toggle" : ""}`}
                    onClick={() => toggleConnectSupplement(selectedBlock.id)}
                    style={{
                      background: connectedSupplements[selectedBlock.id] ? "var(--matched)" : "var(--panel-soft)",
                      border: "1px solid var(--line)",
                      color: "#ffffff"
                    }}
                  >
                    {connectedSupplements[selectedBlock.id] ? "已连接补充卡片" : "连接补充卡片"}
                  </button>

                  <button
                    type="button"
                    className="primary-action"
                    disabled={generatingSlotId !== null || !connectedSupplements[selectedBlock.id] || selectedBlock.status === "matched"}
                    onClick={() => handleTriggerAiGeneration(selectedBlock.id)}
                  >
                    {generatingSlotId === selectedBlock.id ? "AIGC 生成中..." : "AI 生成素材"}
                  </button>
                </div>

                {connectedSupplements[selectedBlock.id] && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <label style={{ fontSize: "12px", color: "var(--text-muted)" }}>修改AI提示词 (Prompt):</label>
                    <input
                      type="text"
                      className="migration-input"
                      style={{ textAlign: "left", fontSize: "13px" }}
                      defaultValue={
                        selectedBlock.id === "slot_01"
                          ? "新手买猫粮警示画面，大字警告，3D质感"
                          : selectedBlock.id === "slot_04"
                          ? "成分对比卡片，横向网格，扁平化现代UI"
                          : "结尾猫咪吃粮引导关注，暖色调，评论条"
                      }
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* AI Image Grid Selector Modal */}
      {showAiSelector && (
        <div className="ai-selector-modal" style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.85)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 100
        }}>
          <div style={{
            background: "var(--panel)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius)",
            padding: "24px",
            maxWidth: "520px",
            width: "90%",
            boxShadow: "0 20px 50px rgba(0,0,0,0.6)"
          }}>
            <h3 style={{ margin: "0 0 8px", color: "var(--text-strong)" }}>AIGC 4选1 智能物料生成</h3>
            <p style={{ color: "var(--text-muted)", fontSize: "13px", margin: "0 0 16px" }}>AI 一次性为您生成了4张拼贴与包装卡片方案。请点击选择其中一张作为新素材的主图：</p>
            
            <div className="ai-image-grid" style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: "12px",
              marginBottom: "20px"
            }}>
              {mockAiImages.map((url, i) => (
                <button
                  key={url}
                  type="button"
                  onClick={() => handleSelectAiImage(url)}
                  style={{
                    background: "none",
                    border: "2px solid transparent",
                    borderRadius: "6px",
                    padding: "0",
                    overflow: "hidden",
                    cursor: "pointer",
                    transition: "border-color 0.2s"
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--theme)")}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}
                >
                  <img src={url} alt={`Option ${i + 1}`} style={{ width: "100%", height: "140px", objectFit: "cover", display: "block" }} />
                </button>
              ))}
            </div>

            <button
              type="button"
              className="primary-action"
              style={{ width: "100%" }}
              onClick={() => setShowAiSelector(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </section>
  );
};
