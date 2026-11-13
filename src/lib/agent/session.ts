/**
 * Persistent agent session: one per agent, kept across runs (like a Claude Code conversation).
 * - A NEW agent gets a fresh microVM + empty session.
 * - The SAME agent continues its context: we chain xAI responses with previous_response_id.
 * - We also keep a compact local transcript (no reasoning) so we can summarize at 150K tokens.
 * Stored on the host OUTSIDE the microVM mounts (~/.cosign/sandboxes/<agent>/session.json),
 * so the agent cannot read or edit its own session file. Server-only.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxPaths } from "../sandbox";

export const DEFAULT_COMPACT_AT = 150_000; // tokens of context before we compact

export type TranscriptEntry =
  | { kind: "user"; text: string; t: string }
  | { kind: "assistant"; text: string; t: string }
  | { kind: "tool"; name: string; args: unknown; result: string; t: string }
  | { kind: "search"; tool: string; query?: string; t: string }
  | { kind: "summary"; text: string; t: string };

export type LedgerEntry = { t: string; tool: string; detail: Record<string, unknown> };

export type Session = {
  agent: string;
  createdAt: string;
  chainId: string; // changes whenever a new response chain starts (first run, after compaction)
  lastResponseId?: string; // xAI previous_response_id for continuing the chain
  lastContextTokens: number; // input + output tokens of the latest response = current context size
  compactAt: number;
  compactions: number;
  postCompactionTokens?: number; // context size right after the last compaction (baseline)
  awaitingBaseline?: boolean;
  runs: number;
  memoryIndexHash?: string; // last memory index the agent was shown
  transcript: TranscriptEntry[];
  ledger: LedgerEntry[]; // money facts, pinned verbatim through compaction
};

const fileFor = (agent: string) => join(sandboxPaths(agent).base, "session.json");
const newChainId = () => Math.random().toString(36).slice(2, 10);

export function loadSession(agent: string, compactAt = DEFAULT_COMPACT_AT): Session {
  const f = fileFor(agent);
  if (existsSync(f)) {
    const s = JSON.parse(readFileSync(f, "utf8")) as Session;
    s.compactAt = compactAt;
    return s;
  }
  return {
    agent,
    createdAt: new Date().toISOString(),
    chainId: newChainId(),
    lastContextTokens: 0,
    compactAt,
    compactions: 0,
    runs: 0,
    transcript: [],
    ledger: [],
  };
}

export function saveSession(s: Session) {
  const f = fileFor(s.agent);
  writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 2));
  renameSync(`${f}.tmp`, f); // atomic replace
}

/** Start a new response chain (used after compaction). Old transcript is replaced by the summary. */
export function startNewChain(s: Session, summary: string) {
  s.chainId = newChainId();
  s.lastResponseId = undefined;
  s.lastContextTokens = 0;
  s.compactions += 1;
  s.awaitingBaseline = true;
  s.transcript = [{ kind: "summary", text: summary, t: new Date().toISOString() }];
}

export const now = () => new Date().toISOString();

/** Compact only at the threshold, and only after the context has grown past its post-compaction size
 *  (prevents compacting again when the fresh summary context itself is large). */
export function shouldCompact(s: Session): boolean {
  if (s.lastContextTokens < s.compactAt) return false;
  const baseline = s.postCompactionTokens ?? 0;
  return s.lastContextTokens >= baseline + s.compactAt * 0.25;
}
