/**
 * Voice for the browser-test agent: its own ElevenLabs agent ("Cosign: Clerk (browser test)", so the demo's stays
 * as it is), answered by our server through the public URL, and a spoken question for Chrome's fake microphone.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";

export const QUESTION_WAV = "node_modules/.cosign-tmp/voice-question.wav";

/** A short spoken question (after a pause, so the agent's greeting comes first), made once with macOS `say`. */
export function ensureQuestion() {
  if (existsSync(QUESTION_WAV)) return;
  mkdirSync("node_modules/.cosign-tmp", { recursive: true });
  execFileSync("say", ["-o", QUESTION_WAV, "--data-format=LEI16@48000", "[[slnc 4500]] What is waiting for approval right now?"]);
}

export async function ensureVoice(agentId: string): Promise<string> {
  if (!process.env.ELEVENLABS_API_KEY) return "no ELEVENLABS_API_KEY: the voice spec skips";
  const { readConfig, setupVoice } = await import("../../src/lib/server/voice");
  const { db, schema } = await import("../../src/lib/db");
  const { checkReachable, publicBase } = await import("../../scripts/lib/demo");
  const base = await publicBase();
  await checkReachable(base);
  const cfg = readConfig();
  if (cfg.agents[agentId] && cfg.base === base) return "voice ready";
  if (cfg.base && cfg.base !== base) return `the public URL changed (${cfg.base} → ${base}); run pnpm voice setup first`;
  const row = db().select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  if (!row) return "no agent";
  await setupVoice({ ...row, name: `${row.name} (browser test)` }, base);
  return "voice set up";
}
