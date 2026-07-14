export interface WordTok {
  text: string;
  changed: boolean;
}

function tokenize(s: string): string[] {
  return s.match(/(\s+|\w+|[^\w\s]+)/g) ?? [];
}

/**
 * Token-level diff of two strings via LCS. Returns per-side token lists where
 * `changed` marks tokens unique to that side — used to highlight intra-line
 * edits within a del/add pair.
 */
export function wordDiff(a: string, b: string): { left: WordTok[]; right: WordTok[] } {
  const at = tokenize(a);
  const bt = tokenize(b);
  const n = at.length;
  const m = bt.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = at[i] === bt[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const left: WordTok[] = [];
  const right: WordTok[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (at[i] === bt[j]) {
      left.push({ text: at[i], changed: false });
      right.push({ text: bt[j], changed: false });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      left.push({ text: at[i], changed: true });
      i++;
    } else {
      right.push({ text: bt[j], changed: true });
      j++;
    }
  }
  while (i < n) left.push({ text: at[i++], changed: true });
  while (j < m) right.push({ text: bt[j++], changed: true });
  return { left, right };
}
