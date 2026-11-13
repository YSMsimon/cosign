/**
 * Run logger for debugging agents: one JSONL file per run (logs/runs/YYYY-MM-DD/<runId>.jsonl)
 * plus a compact console line. Plain append-only events, no state machine.
 * Secrets are redacted before anything is written.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SECRET_KEY = /(secret|private|api[_-]?key|password|signature|authorization|bearer|^token$|access[_-]?token|auth[_-]?token|refresh[_-]?token)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth]";
  if (typeof value === "string") {
    if (/^0x[0-9a-fA-F]{130,132}$/.test(value)) return `${value.slice(0, 10)}…[sig]`;
    if (/^(xai-|sk-|TEST_API_KEY:|LIVE_API_KEY:)/.test(value)) return "[redacted]";
    return value.length > 4000 ? `${value.slice(0, 4000)}…[+${value.length - 4000} chars]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  return value;
}

export type RunLogger = ReturnType<typeof createRunLogger>;

export function createRunLogger(meta: { agent: string; kind: string; [k: string]: unknown }, opts: { quiet?: boolean } = {}) {
  const started = Date.now();
  const runId = `${new Date(started).toISOString().replace(/[-:]/g, "").slice(0, 15)}-${meta.agent}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = join(process.env.LOG_DIR ?? "logs", "runs", new Date(started).toISOString().slice(0, 10));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${runId}.jsonl`);
  let seq = 0;

  function event(type: string, data: Record<string, unknown> = {}) {
    const rec = { ...(redact(data) as object), runId, seq: seq++, t: new Date().toISOString(), ms: Date.now() - started, type };
    appendFileSync(file, JSON.stringify(rec) + "\n");
    if (!opts.quiet) console.log(`[${String(rec.ms).padStart(6)}ms] ${type.padEnd(16)} ${summarize(data)}`);
    return rec;
  }
  event("run_start", meta);
  return { runId, file, event };
}

function summarize(d: Record<string, unknown>): string {
  const s = JSON.stringify(redact(d));
  return s.length > 220 ? `${s.slice(0, 220)}…` : s;
}
