/**
 * QuickNode Streams webhook signature: hex(HMAC-SHA256(securityToken, nonce + timestamp + body)),
 * sent in x-qn-nonce / x-qn-timestamp / x-qn-signature. The body is the uncompressed JSON.
 * Server-only.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_SKEW_SEC = 300;

export function signQuickNode(secret: string, nonce: string, timestamp: string, body: string) {
  return createHmac("sha256", Buffer.from(secret)).update(Buffer.from(nonce + timestamp + body)).digest("hex");
}

export function verifyQuickNode(
  secret: string | undefined,
  headers: Headers,
  body: string,
): { ok: true; nonce: string } | { ok: false; reason: string } {
  if (!secret) return { ok: false, reason: "server has no QUICKNODE_STREAM_SECURITY_TOKEN" };
  const nonce = headers.get("x-qn-nonce");
  const timestamp = headers.get("x-qn-timestamp");
  const given = headers.get("x-qn-signature");
  if (!nonce || !timestamp || !given) return { ok: false, reason: "missing x-qn-* headers" };
  const ts = Number(timestamp);
  const nowSec = Math.floor(Date.now() / 1000);
  const tsSec = ts > 1e12 ? Math.floor(ts / 1000) : ts; // accept seconds or milliseconds
  if (!Number.isFinite(tsSec) || Math.abs(nowSec - tsSec) > MAX_SKEW_SEC) return { ok: false, reason: "stale or invalid timestamp" };
  const expected = signQuickNode(secret, nonce, timestamp, body);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(given, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };
  return { ok: true, nonce };
}
