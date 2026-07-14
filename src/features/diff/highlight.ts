import { useEffect, useState } from "react";
import type { Highlighter } from "shiki";

// Lazy singleton — shiki (and its grammars) load only when a diff is first
// viewed, keeping the initial bundle light.
let highlighterPromise: Promise<Highlighter> | null = null;

const LANGS = [
  "javascript", "typescript", "tsx", "jsx", "json", "rust", "python", "go",
  "java", "c", "cpp", "css", "html", "markdown", "yaml", "toml", "bash", "sql",
];

const THEME = "github-dark";

function loadHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((shiki) =>
      shiki.createHighlighter({ themes: [THEME], langs: LANGS }),
    );
  }
  return highlighterPromise;
}

/** React hook: returns the highlighter once loaded, or null meanwhile. */
export function useHighlighter(): Highlighter | null {
  const [hl, setHl] = useState<Highlighter | null>(null);
  useEffect(() => {
    let alive = true;
    loadHighlighter().then((h) => {
      if (alive) setHl(h);
    });
    return () => {
      alive = false;
    };
  }, []);
  return hl;
}

const EXT_TO_LANG: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "tsx", jsx: "jsx",
  json: "json", rs: "rust", py: "python", go: "go", java: "java",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  css: "css", scss: "css", html: "html", htm: "html",
  md: "markdown", markdown: "markdown",
  yml: "yaml", yaml: "yaml", toml: "toml",
  sh: "bash", bash: "bash", zsh: "bash", sql: "sql",
};

export function langForPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  return EXT_TO_LANG[ext] ?? null;
}

export interface Tok {
  content: string;
  color?: string;
}

/** Tokenize a single line of code; returns one plain token if unsupported. */
export function tokenizeLine(hl: Highlighter | null, text: string, lang: string | null): Tok[] {
  if (!hl || !lang) return [{ content: text }];
  try {
    const lines = hl.codeToTokensBase(text, { lang: lang as never, theme: THEME });
    const row = lines[0] ?? [];
    return row.map((t) => ({ content: t.content, color: t.color }));
  } catch {
    return [{ content: text }];
  }
}

export const THEME_NAME = THEME;
