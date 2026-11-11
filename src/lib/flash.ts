import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/**
 * Success / error banners travel in the URL (?ok=… or ?error=…) after a form
 * post. Each one is signed (&fs=…), so only messages the app itself produced
 * are shown: a crafted link such as /login?error=Your+account+is+blocked,+call…
 * displays nothing.
 */
export type FlashKind = "ok" | "error";

function sign(kind: FlashKind, message: string) {
  return createHmac("sha256", env.sessionSecret).update(`flash:${kind}:${message}`).digest("base64url").slice(0, 22);
}

export function isValidFlash(kind: FlashKind, message: string, sig: string | undefined) {
  if (!sig) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(kind, message));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** path with ?ok=/?error= and its signature set (other query parameters are kept). */
export function flashUrl(path: string, kind: FlashKind, message: string, extra: Record<string, string> = {}) {
  const [beforeHash, hash] = path.split("#", 2) as [string, string | undefined];
  const [base, query = ""] = beforeHash.split("?");
  const params = new URLSearchParams(query);
  params.delete("error");
  params.delete("ok");
  params.delete("fs");
  params.set(kind, message);
  params.set("fs", sign(kind, message));
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return `${base}?${params.toString()}${hash ? `#${hash}` : ""}`;
}
