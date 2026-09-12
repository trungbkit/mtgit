import { useEffect, useState } from "react";
import type { Highlighter } from "shiki";
import { useSettings } from "../../stores/settings";

// Lazy singleton — shiki (and its grammars) load only when a diff is first
// viewed, keeping the initial bundle light.
let highlighterPromise: Promise<Highlighter> | null = null;

const LANGS = [
  "javascript", "typescript", "tsx", "jsx", "json", "rust", "python", "go",
  "java", "c", "cpp", "css", "html", "markdown", "yaml", "toml", "bash", "sql",
];

/**
 * Both themes are loaded, and the one used is chosen per call.
 *
 * This used to be a single `github-dark` constant, which made the diff, the
 * blame gutter and the file viewer the last three surfaces in the app that
 * ignored the light theme — a dark palette's greys and blues over a white
 * ground, which is exactly the failure P6 fixed in six stylesheets and missed
 * here because it is TypeScript rather than CSS.
 *
 * The decision is read off the document rather than out of the settings store,
 * for the same reason `palette.ts` reads the lane ring from CSS: "system" is
 * the *absence* of `data-theme`, so the DOM is the only place the resolved
 * answer exists.
 */
const THEMES = ["github-light", "github-dark"] as const;

function resolveTheme(): (typeof THEMES)[number] {
  if (typeof document === "undefined") return "github-dark";
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "dark") return "github-dark";
  if (explicit === "light") return "github-light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "github-dark"
    : "github-light";
}

function loadHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((shiki) =>
      shiki.createHighlighter({ themes: [...THEMES], langs: LANGS }),
    );
  }
  return highlighterPromise;
}

/**
 * React hook: the highlighter once loaded, or null meanwhile.
 *
 * It also subscribes to whatever decides the theme, so a component that
 * tokenizes lines re-renders — and re-colours them — when the theme changes.
 * Both sources are needed: the setting covers an explicit Light/Dark choice,
 * and the media query covers "system" following the OS while the app is open.
 */
export function useHighlighter(): Highlighter | null {
  const [hl, setHl] = useState<Highlighter | null>(null);
  useSettings((s) => s.settings.theme);
  const [, bumpSystemTheme] = useState(0);

  useEffect(() => {
    let alive = true;
    loadHighlighter().then((h) => {
      if (alive) setHl(h);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => bumpSystemTheme((n) => n + 1);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
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
    const lines = hl.codeToTokensBase(text, { lang: lang as never, theme: resolveTheme() });
    const row = lines[0] ?? [];
    return row.map((t) => ({ content: t.content, color: t.color }));
  } catch {
    return [{ content: text }];
  }
}
