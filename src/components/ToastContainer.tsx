import { useToasts } from "../stores/toasts";
import { useState } from "react";
import { copyText } from "../lib/clipboard";
import "./toasts.css";

export function ToastContainer() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}${expanded.has(t.id) ? " expanded" : ""}`}>
          <button
            className="toast-message"
            onClick={() =>
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(t.id)) next.delete(t.id);
                else next.add(t.id);
                return next;
              })
            }
          >
            {t.message}
          </button>
          {t.action && (
            <button
              className="toast-action"
              onClick={async () => {
                // Dismiss first: the action refreshes the repo, and a toast
                // still offering "Undo" after it ran invites a second undo.
                dismiss(t.id);
                await t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          {t.kind === "error" && (
            <button className="toast-copy" onClick={() => copyText(t.message)} title="Copy error">
              Copy
            </button>
          )}
          <button className="toast-close" onClick={() => dismiss(t.id)} title="Dismiss">✕</button>
        </div>
      ))}
    </div>
  );
}
