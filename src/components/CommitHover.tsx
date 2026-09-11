import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCommit } from "../ipc/commands";
import { formatTimestamp, timeAgo } from "../lib/time";
import { Avatar } from "./Avatar";
import { Autolinked } from "./Autolinked";
import "./commit-hover.css";

/**
 * The rich hover (G21): who wrote this line, when, in which commit, and with
 * what message.
 *
 * Three decisions worth knowing:
 *
 * * **It fetches on hover, not on render.** A blamed file is thousands of
 *   lines and a handful of commits; prefetching all of them to satisfy a
 *   hover nobody performs is a page of IPC for nothing. The query key is
 *   shared with the commit panel, so hovering a line the panel already loaded
 *   costs no request at all.
 * * **It opens after a delay and closes immediately.** A hover card that
 *   appears the instant the pointer crosses a row turns scanning a file into
 *   a strobe.
 * * **It flips rather than clips.** The card is placed against the viewport
 *   by measurement, because the blame view is a scroll container and a card
 *   near the bottom would otherwise be cut off with no way to read it.
 */

const OPEN_DELAY_MS = 380;

export function CommitHover({
  repoPath,
  oid,
  children,
  className,
  onClick,
}: {
  repoPath: string;
  /** Empty string for a line with no blame — the card then never opens. */
  oid: string;
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div
      ref={anchor}
      className={className}
      onClick={onClick}
      onMouseEnter={() => {
        if (!oid) return;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
      }}
      onMouseLeave={() => {
        clearTimeout(timer.current);
        setOpen(false);
      }}
    >
      {children}
      {open && <HoverCard repoPath={repoPath} oid={oid} anchor={anchor.current} />}
    </div>
  );
}

function HoverCard({
  repoPath,
  oid,
  anchor,
}: {
  repoPath: string;
  oid: string;
  anchor: HTMLElement | null;
}) {
  const card = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const { data, error } = useQuery({
    // The same key the commit panel uses, so the two share one fetch.
    queryKey: ["commit", repoPath, oid],
    queryFn: () => getCommit(repoPath, oid),
  });

  useLayoutEffect(() => {
    const box = anchor?.getBoundingClientRect();
    const own = card.current?.getBoundingClientRect();
    if (!box || !own) return;
    const margin = 8;
    const below = box.bottom + margin;
    const top = below + own.height > window.innerHeight ? Math.max(margin, box.top - own.height - margin) : below;
    const left = Math.min(Math.max(margin, box.left), window.innerWidth - own.width - margin);
    setPos({ top, left });
  }, [anchor, data]);

  return (
    <div
      ref={card}
      className="commit-hover"
      // Hidden until measured: an unplaced card flashes at the origin first.
      style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}
      role="tooltip"
    >
      {error && <div className="commit-hover-note">{String(error)}</div>}
      {!data && !error && <div className="commit-hover-note">Loading…</div>}
      {data && (
        <>
          <div className="commit-hover-head">
            <Avatar email={data.authorEmail} name={data.authorName} size={26} />
            <div className="commit-hover-who">
              <b>{data.authorName}</b>
              <span title={formatTimestamp(data.authorTime)}>{timeAgo(data.authorTime)}</span>
            </div>
            <code className="commit-hover-oid">{data.oid.slice(0, 7)}</code>
          </div>
          <div className="commit-hover-summary">
            <Autolinked repoPath={repoPath} text={data.summary} />
          </div>
          {data.body && (
            <pre className="commit-hover-body">
              <Autolinked repoPath={repoPath} text={data.body} />
            </pre>
          )}
          <div className="commit-hover-foot">
            {data.files.length} file{data.files.length === 1 ? "" : "s"} changed
          </div>
        </>
      )}
    </div>
  );
}
