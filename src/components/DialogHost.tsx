import { useEffect, useRef, useState } from "react";
import { useDialog } from "../stores/dialog";
import "./dialog.css";

/** Renders the active modal dialog (prompt/confirm). Mount once, near the root. */
export function DialogHost() {
  const current = useDialog((s) => s.current);
  const close = useDialog((s) => s.close);

  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset local state each time a new dialog opens.
  useEffect(() => {
    if (current?.kind === "prompt") {
      setValue(current.defaultValue ?? "");
      setError(null);
      // Focus + select after paint.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [current]);

  if (!current) return null;

  const cancel = () => {
    if (current.kind === "prompt") current.resolve(null);
    else if (current.kind === "confirm") current.resolve(false);
    else current.resolve(null);
    close();
  };

  const submit = () => {
    if (current.kind === "choice") return;
    if (current.kind === "prompt") {
      const v = value.trim();
      const err = current.validate?.(v) ?? null;
      if (err) {
        setError(err);
        return;
      }
      current.resolve(v);
    } else {
      current.resolve(true);
    }
    close();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      if (current.kind === "choice") return;
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  const danger = current.kind === "confirm" && current.danger;

  return (
    <div className="dialog-overlay" onMouseDown={cancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="dialog-title">{current.title}</div>
        {current.message && <div className="dialog-message">{current.message}</div>}

        {current.kind === "prompt" && (
          <>
            {current.label && <label className="dialog-label">{current.label}</label>}
            <input
              ref={inputRef}
              className={`dialog-input${error ? " invalid" : ""}`}
              value={value}
              placeholder={current.placeholder}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(current.validate?.(e.target.value.trim()) ?? null);
              }}
            />
            {error && <div className="dialog-error">{error}</div>}
          </>
        )}

        {current.kind === "choice" ? (
          <div className="dialog-choice-actions">
            {current.choices.map((choice) => (
              <button
                key={choice.value}
                className={`dialog-btn${choice.danger ? " danger" : ""}`}
                onClick={() => {
                  current.resolve(choice.value);
                  close();
                }}
              >
                {choice.label}
              </button>
            ))}
            <button className="dialog-btn" onClick={cancel}>{current.cancelLabel ?? "Cancel"}</button>
          </div>
        ) : (
          <div className="dialog-actions">
            <button className="dialog-btn" onClick={cancel}>
              Cancel
            </button>
            <button className={`dialog-btn primary${danger ? " danger" : ""}`} onClick={submit}>
              {current.kind === "confirm"
                ? (current.confirmLabel ?? "Confirm")
                : (current.confirmLabel ?? "OK")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
