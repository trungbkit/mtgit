import { useSession } from "../../stores/session";
import "./tabs.css";

export function TabBar() {
  const tabs = useSession((s) => s.tabs);
  const repo = useSession((s) => s.repo);
  const switchTab = useSession((s) => s.switchTab);
  const closeTab = useSession((s) => s.closeTab);

  if (tabs.length <= 1) return null;

  return (
    <div className="tab-bar">
      {tabs.map((t) => (
        <div
          key={t.path}
          className={`tab${repo?.path === t.path ? " active" : ""}`}
          onClick={() => switchTab(t.path)}
          title={t.path}
        >
          <span className="tab-name">{t.name}</span>
          <button
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation();
              closeTab(t.path);
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
