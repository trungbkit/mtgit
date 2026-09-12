import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listRefs } from "../../ipc/commands";
import { findRefs } from "../../lib/refFinder";
import { Icon } from "../../components/Icon";
import "./branch-finder.css";

/**
 * The `/` branch finder (`02-checkout.md` §2).
 *
 * Deliberately *not* the command palette. The palette acts — Enter checks a
 * branch out — and that is the wrong verb nine times out of ten while you are
 * reading history: you want to see where `release/2.1` is, not to move your
 * working tree onto it. This one only scrolls to and selects the tip, which is
 * also why it can be a bare `/` with no confirmation step.
 */
export function BranchFinder({
  repoPath,
  onPick,
  onClose,
}: {
  repoPath: string;
  onPick: (oid: string, name: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: refs } = useQuery({
    queryKey: ["refs", repoPath],
    queryFn: () => listRefs(repoPath),
  });
  const results = useMemo(() => findRefs(refs, query), [refs, query]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => inputRef.current?.focus(), []);

  const commit = (index: number) => {
    const found = results[index];
    if (found) onPick(found.oid, found.name);
    onClose();
  };

  return (
    <div className="bf-overlay" onMouseDown={onClose}>
      <div className="bf" onMouseDown={(event) => event.stopPropagation()}>
        <div className="bf-field">
          <Icon name="search" size={13} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Jump to a branch or tag…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setCursor((at) => Math.min(results.length - 1, at + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setCursor((at) => Math.max(0, at - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                commit(cursor);
              }
            }}
          />
        </div>
        {results.length === 0 ? (
          <div className="bf-empty">No branch or tag matches.</div>
        ) : (
          <ul className="bf-list">
            {results.map((found, index) => (
              <li key={`${found.kind}-${found.name}`}>
                <button
                  type="button"
                  className={`bf-item${index === cursor ? " active" : ""}`}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => commit(index)}
                >
                  <Icon
                    name={found.kind === "tag" ? "tag" : found.kind === "remote" ? "cloud" : "branch"}
                    size={12}
                  />
                  <span className="bf-name">{found.name}</span>
                  {found.isHead && <span className="bf-tag">current</span>}
                  <span className="bf-sha">{found.oid.slice(0, 7)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="bf-hint">Enter selects the tip — it does not check anything out.</div>
      </div>
    </div>
  );
}
