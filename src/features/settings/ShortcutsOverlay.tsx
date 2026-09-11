import { useEffect, useRef } from "react";
import { ACTIONS, chordFor, formatChord } from "../../lib/keys";
import "./settings.css";

/**
 * The `?` cheat sheet (G13).
 *
 * Read-only on purpose: it is the thing you open mid-task to remember one
 * chord, and a panel you can accidentally rebind from is not that. Rebinding
 * lives in Settings → Shortcuts, one click away through the footer link.
 *
 * It renders `ACTIONS` rather than a list of its own, so a shortcut cannot be
 * added to the app and missed here — which is how the app ended up with "two
 * keyboard shortcuts total" and no way to discover either.
 */
export function ShortcutsOverlay({ onClose, onOpenSettings }: { onClose: () => void; onOpenSettings: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const groups = [...new Set(ACTIONS.map((a) => a.group))];

  return (
    <div className="settings-overlay" onMouseDown={onClose}>
      <div
        className="shortcuts-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        ref={ref}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "?") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="settings-head">
          <span className="settings-title">Keyboard shortcuts</span>
        </div>
        <div className="shortcuts-grid">
          {groups.map((group) => (
            <div className="shortcuts-group" key={group}>
              <h4>{group}</h4>
              {ACTIONS.filter((a) => a.group === group).map((action) => (
                <div className="shortcuts-line" key={action.id}>
                  <span>{action.label}</span>
                  <span className="shortcuts-chords">
                    <kbd>{formatChord(chordFor(action.id))}</kbd>
                    {action.also?.map((alt) => (
                      <kbd className="alt" key={alt}>
                        {formatChord(alt)}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="settings-foot">
          <span className="settings-hint">Escape closes.</span>
          <button
            onClick={() => {
              onClose();
              onOpenSettings();
            }}
          >
            Change shortcuts…
          </button>
        </div>
      </div>
    </div>
  );
}
