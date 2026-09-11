/**
 * `Co-authored-by:` trailers (`01-commit.md` §7).
 *
 * Pure and separate from the commit form because the placement rule is the
 * only interesting part and it is easy to get subtly wrong: git recognises
 * trailers **only in the last paragraph**, so a blank line inserted between
 * two of them silently demotes the second to prose.
 */

/** Emails already credited in the message, lowercased. */
export function coAuthorEmails(body: string): Set<string> {
  const out = new Set<string>();
  for (const line of body.split("\n")) {
    const match = /^\s*co-authored-by:.*<([^>]+)>/i.exec(line);
    if (match) out.add(match[1].trim().toLowerCase());
  }
  return out;
}

/** Append a trailer, joining an existing trailer block rather than splitting it. */
export function addCoAuthor(body: string, name: string, email: string): string {
  const trailer = `Co-authored-by: ${name || email} <${email}>`;
  const trimmed = body.replace(/\s+$/, "");
  if (!trimmed) return trailer;
  const lastLine = trimmed.split("\n").pop() ?? "";
  const inTrailerBlock = /^[A-Za-z-]+:\s/.test(lastLine);
  return `${trimmed}${inTrailerBlock ? "\n" : "\n\n"}${trailer}`;
}
