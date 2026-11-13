/**
 * Small pure helpers: ids, tokens, hashing, secret encryption, schedule times. Server-only.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789";
export function id(prefix: string, n = 10): string {
  const b = randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHA[b[i] % ALPHA.length];
  return `${prefix}_${s}`;
}

/** Agent refs name the microVM, the sandbox folder and the Circle wallet refId. */
export function agentRef(): string {
  return `agent-${id("x", 8).slice(2)}`;
}

export const newToken = () => randomBytes(32).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ───────────── secrets at rest (AES-256-GCM, key from COSIGN_SECRET) ─────────────
function key(): Buffer {
  const s = process.env.COSIGN_SECRET;
  if (!s || s.length < 32) throw new Error("COSIGN_SECRET must be set (32+ chars) in .env.local");
  return createHash("sha256").update(s).digest();
}
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}
export function decryptSecret(blob: string): string {
  const [v, iv, tag, enc] = blob.split(".");
  if (v !== "v1") throw new Error("unknown secret format");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
}

// ───────────── schedules (UTC) ─────────────
export type Every = "hour" | "day" | "week";
export type ScheduleSpec = { every: Every; minute: number; hour?: number | null; weekday?: number | null }; // weekday 0 = Sunday

export function validateSpec(s: Partial<ScheduleSpec>): ScheduleSpec {
  const every = s.every;
  if (every !== "hour" && every !== "day" && every !== "week") throw new Error('every must be "hour", "day" or "week"');
  const int = (v: unknown, lo: number, hi: number, name: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name} must be an integer ${lo}–${hi}`);
    return n;
  };
  const minute = int(s.minute ?? 0, 0, 59, "minute");
  const hour = every === "hour" ? null : int(s.hour ?? 9, 0, 23, "hour");
  const weekday = every === "week" ? int(s.weekday ?? 1, 0, 6, "weekday") : null;
  return { every, minute, hour, weekday };
}

/** The first run strictly after `from` (UTC). */
export function nextRun(spec: ScheduleSpec, from: Date): Date {
  const d = new Date(from.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(spec.minute);
  if (spec.every === "hour") {
    if (d <= from) d.setUTCHours(d.getUTCHours() + 1);
    return d;
  }
  d.setUTCHours(spec.hour ?? 0);
  if (spec.every === "day") {
    if (d <= from) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  const delta = ((spec.weekday ?? 0) - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + delta);
  if (d <= from) d.setUTCDate(d.getUTCDate() + 7);
  return d;
}
