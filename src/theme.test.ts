import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Dark is written twice: once under `prefers-color-scheme`, once under an
 * explicit `[data-theme="dark"]`. They are two blocks, not a block and a delta,
 * so a token added to one and forgotten in the other leaves the *chosen* dark
 * theme half light — and only for the users whose OS is set the other way,
 * which is why nobody sees it.
 *
 * Asserted against the stylesheet because vitest applies none of it: nothing
 * here renders, so `getComputedStyle` would agree with whatever is written.
 */
const css = readFileSync("src/theme.css", "utf8");

/** The declarations of the `:root` rule whose selector text matches. */
function block(pattern: RegExp): string {
  const match = pattern.exec(css);
  if (!match) throw new Error(`no rule matching ${pattern} in theme.css`);
  const open = css.indexOf("{", match.index);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unclosed rule matching ${pattern} in theme.css`);
}

function tokens(body: string): Set<string> {
  return new Set(body.match(/--[a-z0-9-]+(?=\s*:)/g) ?? []);
}

const light = tokens(block(/\n:root \{/));
const mediaDark = tokens(block(/:root:not\(\[data-theme="light"\]\) \{/));
const explicitDark = tokens(block(/:root\[data-theme="dark"\] \{/));

describe("the dark theme", () => {
  it("defines the same tokens whether it was chosen or inherited from the OS", () => {
    // `--ok-tint` was missing from the explicit block once before, which
    // painted every remote-branch pill green-on-green under a light OS.
    expect([...mediaDark].filter((t) => !explicitDark.has(t))).toEqual([]);
    expect([...explicitDark].filter((t) => !mediaDark.has(t))).toEqual([]);
  });

  it("only ever overrides a token the light theme already established", () => {
    // A token defined in a dark block alone has no light value to fall back
    // to, so the light theme renders it as an invalid value and drops it.
    expect([...mediaDark].filter((t) => !light.has(t))).toEqual([]);
  });
});
