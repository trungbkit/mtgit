import { useQuery } from "@tanstack/react-query";
import { fileAtCommit } from "../../ipc/commands";
import { langForPath, tokenizeLine, useHighlighter } from "./highlight";
import "./diff.css";

const MAX_HIGHLIGHT_LINES = 2000;

export function FileContentView({ repoPath, oid, file }: { repoPath: string; oid: string; file: string }) {
  const hl = useHighlighter();
  const lang = langForPath(file);
  const { data, isLoading, error } = useQuery({
    queryKey: ["fileContent", repoPath, oid, file],
    queryFn: () => fileAtCommit(repoPath, oid, file),
  });

  if (isLoading) return <div className="diff-note">Loading…</div>;
  if (error) return <div className="diff-note">{String(error)}</div>;
  if (!data) return <div className="diff-note">No content.</div>;
  if (data.binary) return <div className="diff-note">Binary file — no preview.</div>;
  if (data.isLarge) return <div className="diff-note">File too large to display.</div>;

  const lines = data.text.split("\n");
  const canHighlight = lines.length <= MAX_HIGHLIGHT_LINES ? hl : null;

  return (
    <div className="diff-code fileview">
      {lines.map((line, i) => (
        <div key={i} className="dline">
          <span className="gutter">{i + 1}</span>
          <span className="content">
            {tokenizeLine(canHighlight, line, lang).map((t, j) => (
              <span key={j} style={t.color ? { color: t.color } : undefined}>
                {t.content}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}
