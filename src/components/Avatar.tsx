import { useEffect, useState } from "react";
import "./avatar.css";

/** Deterministic fallback color from an email/name seed. */
export function hashColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) & 0xffff;
  return `hsl(${h % 360} 45% 40%)`;
}

/** Up-to-two-letter initials from a display name. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input.trim().toLowerCase());
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Commit avatar. Tries Gravatar (SHA-256 hash of the email; `d=404` so unknown
 * emails 404 instead of returning a placeholder), and falls back to a
 * color-hashed initials badge when there's no image.
 */
export function Avatar({ email, name, size = 24 }: { email: string; name: string; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setUrl(null);
    if (!email) return;
    sha256Hex(email)
      .then((hash) => {
        if (!cancelled) setUrl(`https://www.gravatar.com/avatar/${hash}?s=${size * 2}&d=404`);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [email, size]);

  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };

  if (url && !failed) {
    return (
      <img
        className="avatar-img"
        style={style}
        src={url}
        alt={name}
        onError={() => setFailed(true)}
        draggable={false}
      />
    );
  }
  return (
    <div className="avatar-fallback" style={{ ...style, background: hashColor(email || name) }} title={name}>
      {initials(name)}
    </div>
  );
}
