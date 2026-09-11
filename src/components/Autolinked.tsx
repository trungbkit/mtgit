import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { autolinkPatterns } from "../ipc/commands";
import { splitAutolinks } from "../lib/autolinks";
import { toastError } from "../stores/toasts";
import "./autolinked.css";

/**
 * Commit-message text with issue references linked out (G20).
 *
 * The patterns are queried rather than threaded down as a prop because this
 * renders in four unrelated places (commit detail, the hover card, the graph's
 * message column, file history) and none of them owns repository config. The
 * query is keyed on the repo path per invariant 3, so a `git config` change
 * picked up by a refresh reaches every one of them.
 */
export function Autolinked({ repoPath, text }: { repoPath: string; text: string }) {
  const { data: patterns } = useQuery({
    queryKey: ["autolinks", repoPath],
    queryFn: () => autolinkPatterns(repoPath),
    // Repository config changes far less often than refs do, and a missing
    // pattern degrades to plain text rather than to an error.
    staleTime: 60_000,
  });

  const segments = splitAutolinks(text, patterns ?? []);
  return (
    <>
      {segments.map((segment, i) =>
        segment.href ? (
          <a
            key={i}
            className="autolink"
            href={segment.href}
            title={segment.href}
            onClick={(e) => {
              // The WebView would navigate the app away from itself.
              e.preventDefault();
              e.stopPropagation();
              openUrl(segment.href!).catch(toastError);
            }}
          >
            {segment.text}
          </a>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  );
}
