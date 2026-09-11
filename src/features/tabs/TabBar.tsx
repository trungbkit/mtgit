import { useRef, useState } from "react";
import { useSession } from "../../stores/session";
import "./tabs.css";

/**
 * The repo tab strip (G12).
 *
 * Always visible, because it is where `+` lives and `+` is the second entry
 * point to the start screen. Middle-click closes, drag reorders, and the
 * per-tab selection is restored by the session store rather than discarded.
 */
export function TabBar() {
  const tabs = useSession((s) => s.tabs);
  const repo = useSession((s) => s.repo);
  const startTab = useSession((s) => s.startTab);
  const activeStart = useSession((s) => s.activeStart);
  const switchTab = useSession((s) => s.switchTab);
  const closeTab = useSession((s) => s.closeTab);
  const moveTab = useSession((s) => s.moveTab);
  const openStart = useSession((s) => s.openStart);
  const closeStart = useSession((s) => s.closeStart);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  // Middle-click fires `auxclick` after `mousedown`; swallowing the autoscroll
  // cursor needs the mousedown, and the close belongs on the click.
  const middleDown = useRef(false);

  return (
    <div className="tab-bar" role="tablist">
      {startTab && (
        <div
          className={`tab start${activeStart ? " active" : ""}`}
          role="tab"
          aria-selected={activeStart}
          onClick={openStart}
          onMouseDown={(e) => e.button === 1 && e.preventDefault()}
          onAuxClick={(e) => e.button === 1 && closeStart()}
          title="Start"
        >
          <span className="tab-name">✦ Start</span>
          {tabs.length > 0 && (
            <button
              className="tab-close"
              title="Close start tab"
              onClick={(e) => {
                e.stopPropagation();
                closeStart();
              }}
            >
              ✕
            </button>
          )}
        </div>
      )}

      {tabs.map((t, i) => (
        <div
          key={t.path}
          role="tab"
          aria-selected={!activeStart && repo?.path === t.path}
          className={
            `tab${!activeStart && repo?.path === t.path ? " active" : ""}` +
            `${dragIndex === i ? " dragging" : ""}${overIndex === i && dragIndex !== i ? " drop-target" : ""}`
          }
          draggable
          onDragStart={() => setDragIndex(i)}
          onDragOver={(e) => {
            if (dragIndex === null) return;
            e.preventDefault();
            setOverIndex(i);
          }}
          onDrop={() => {
            if (dragIndex !== null) moveTab(dragIndex, i);
            setDragIndex(null);
            setOverIndex(null);
          }}
          onDragEnd={() => {
            setDragIndex(null);
            setOverIndex(null);
          }}
          onClick={() => switchTab(t.path)}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              middleDown.current = true;
            }
          }}
          onAuxClick={(e) => {
            if (e.button === 1 && middleDown.current) {
              middleDown.current = false;
              closeTab(t.path);
            }
          }}
          title={t.path}
        >
          <span className="tab-name">{t.name}</span>
          {t.head.branch && <span className="tab-branch">{t.head.branch}</span>}
          <button
            className="tab-close"
            title={`Close ${t.name}`}
            onClick={(e) => {
              e.stopPropagation();
              closeTab(t.path);
            }}
          >
            ✕
          </button>
        </div>
      ))}

      <button className="tab-add" title="Open the start screen in a new tab" onClick={openStart}>
        +
      </button>
    </div>
  );
}
