import { useQuery } from "@tanstack/react-query";
import { blameFile } from "../../ipc/commands";
import { langForPath, tokenizeLine, useHighlighter } from "./highlight";
import { Avatar } from "../../components/Avatar";
import "./blame.css";

export function BlameView({
  repoPath,
  oid,
  file,
}: {
  repoPath: string;
  /** Commit to blame at; null blames the working tree. */
  oid: string | null;
  file: string;
}) {
  const hl = useHighlighter();
  const lang = langForPath(file);
  const { data, isLoading, error } = useQuery({
    queryKey: ["blame", repoPath, oid, file],
    queryFn: () => blameFile(repoPath, file, oid ?? undefined),
  });

  if (isLoading) return <div className="diff-note">Loading blame…</div>;
  if (error) return <div className="diff-note">{String(error)}</div>;
  if (!data || data.length === 0) return <div className="diff-note">No blame data.</div>;

  return (
    <div className="blame-code">
      {data.map((l, i) => {
        const prev = data[i - 1];
        const firstOfBlock = !prev || prev.oid !== l.oid;
        return (
          <div key={i} className="blame-line">
            <div className={`blame-meta${firstOfBlock ? " head" : ""}`} title={`${l.summary}\n${l.oid.slice(0, 8)}`}>
              {firstOfBlock ? (
                <>
                  <Avatar email="" name={l.author} size={14} />
                  <span className="blame-author">{l.author}</span>
                  <span className="blame-oid">{l.oid.slice(0, 7)}</span>
                </>
              ) : null}
            </div>
            <span className="blame-no">{l.lineNo}</span>
            <span className="blame-content">
              {tokenizeLine(hl, l.content, lang).map((t, j) => (
                <span key={j} style={t.color ? { color: t.color } : undefined}>
                  {t.content}
                </span>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}
