/**
 * Running a saved agent: build the run context from the agent's settings and the person asking
 * (their role narrows what the agent may do for them), write its rules into the read-only context
 * folder, and run the native Grok loop in that person's own thread. Memory is shared per agent.
 * Server-only.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { agentInstructions } from "../agent/instructions";
import { payeesOf } from "../agent/controls";
import { runAgentTurn } from "../agent/loop";
import { effectiveAbilities, rulesMarkdown } from "../agent/rules";
import type { AgentContext } from "../agent/tools";
import type { AgentRow, WorkspaceRow } from "../db/schema";
import type { RunEventHandler } from "../log";
import { can, canUseAgent } from "../perm/permissions";
import { ensureSandbox, sandboxPaths } from "../sandbox";
import { memberAccess, type Membership } from "./access";
import { accessOf, rulesOf } from "./agents";
import { conflict, forbidden } from "./http";

/**
 * Who a run acts for. `watch`: a job Grok Bot started itself when money moved onchain (no person asked). It may pay
 * to read (an invoice, a vendor check) within the agent's own purchase limits, and never draft or draw petty cash:
 * what to do about a payment is a person's call.
 */
export type Actor = { memberId: string | null; permissions: readonly string[]; watch?: boolean };

/** Everything one run needs. `vm: false` skips the microVM (Grok Bot calls, folder-only work). */
export async function runContext(agent: AgentRow, ws: WorkspaceRow, actor: Actor, o: { taskId?: string | null; vm?: boolean; roomId?: string | null } = {}) {
  const rules = rulesOf(agent);
  const full = effectiveAbilities(rules, { canRequestPayments: actor.watch || can(actor.permissions, "payments.request") });
  const abilities = actor.watch ? { ...full, draft: false, pettyCash: false } : full;
  const payees = payeesOf(ws.id, rules.controls.allowedPayees);
  const files = {
    "policy.md": rulesMarkdown(agent.name, { abilities, controls: rules.controls }, payees),
    "contacts.json": JSON.stringify(payees, null, 2),
  };
  // the microVM starts in the background: only sandbox_bash needs it, and it waits for the start itself
  const sb = await ensureSandbox(agent.ref, files, { vm: (o.vm ?? true) && abilities.sandbox, wait: false });
  const instructions = agentInstructions({ name: agent.name, company: ws.name, role: agent.prompt, sandbox: sb });
  const ctx: AgentContext = {
    agentRef: agent.ref,
    treasury: ws.treasury as Address,
    rules: { abilities, controls: rules.controls },
    scope: { agentId: agent.id, workspaceId: ws.id, memberId: actor.memberId, taskId: o.taskId ?? null, roomId: o.roomId ?? null },
  };
  return { ctx, instructions, sandbox: sb };
}

const g = globalThis as unknown as { __cosignThreadLocks?: Set<string> };
const locks = (g.__cosignThreadLocks ??= new Set<string>());

/** Run one turn under a lock (one turn at a time per conversation). */
export async function runTurn(
  agent: AgentRow,
  ws: WorkspaceRow,
  actor: Actor,
  thread: string,
  prompt: string,
  onEvent?: RunEventHandler,
  taskId?: string | null,
  o: { turnNote?: string; via?: "voice"; stream?: boolean; model?: string; roomId?: string | null } = {},
) {
  const key = `${agent.ref}:${thread}`;
  if (locks.has(key)) throw conflict("this conversation is already running a turn; wait for it to finish");
  locks.add(key);
  try {
    const { ctx, instructions } = await runContext(agent, ws, actor, { taskId, roomId: o.roomId ?? null });
    return await runAgentTurn({ ctx, instructions, prompt, thread, quiet: true, onEvent, turnNote: o.turnNote, via: o.via, stream: o.stream, model: o.model });
  } finally {
    locks.delete(key);
  }
}

/** Wait until a conversation has no turn running (a voice turn waits for the person's typed turn, and the reverse). */
export async function waitForThread(agentRef: string, thread: string, timeoutMs = 120_000) {
  const key = `${agentRef}:${thread}`;
  const until = Date.now() + timeoutMs;
  while (locks.has(key)) {
    if (Date.now() > until) throw conflict("this conversation is still busy with an earlier turn");
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const memberThread = (memberId: string) => `m-${memberId.replace(/[^a-z0-9_-]/gi, "").toLowerCase()}`;

/**
 * A person's conversation with an agent inside a room: its own context, apart from their one-to-one chat, while the
 * agent's memory and files stay shared (Simon, 2026-11-15).
 */
export const roomThread = (memberId: string, room: string) => `${memberThread(memberId)}-r-${room.toLowerCase().replace(/[^a-z0-9_-]/g, "")}`.slice(0, 61);

export function requireUse(m: Membership, agent: AgentRow) {
  if (!canUseAgent(accessOf(agent), memberAccess(m))) {
    throw forbidden(agent.visibility === "private" ? "only its creator can use a private agent" : "your role can't use this agent");
  }
}

/** The caller's own conversation with an agent (from the session file; never another member's). */
export function readThread(agent: AgentRow, memberId: string) {
  const f = join(sandboxPaths(agent.ref).base, "sessions", `${memberThread(memberId)}.json`);
  if (!existsSync(f)) return { runs: 0, contextTokens: 0, compactions: 0, messages: [] };
  const s = JSON.parse(readFileSync(f, "utf8")) as {
    runs: number;
    lastContextTokens: number;
    compactions: number;
    transcript: { kind: string; text?: string; name?: string; args?: Record<string, unknown>; result?: string; t: string; via?: string }[];
  };
  return {
    runs: s.runs,
    contextTokens: s.lastContextTokens,
    compactions: s.compactions,
    messages: s.transcript.map((e) =>
      e.kind === "tool" ? { kind: "tool", name: e.name, args: e.args ?? {}, result: parseResult(e.result), t: e.t } : { kind: e.kind, text: e.text, t: e.t, ...(e.via ? { via: e.via } : {}) },
    ),
  };
}

/** A stored tool result (JSON, cut at 1,500 characters): the object when it parses, else the start of the text. */
function parseResult(raw: string | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw: raw.slice(0, 300) };
  }
}

/** Server-Sent Events: every loop event as `event: step`, then `event: done` (or `error`). */
export function sseTurn(run: (onEvent: RunEventHandler) => Promise<unknown>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };
      try {
        const result = await run((type, data, ms) => send("step", { type, ms, data }));
        send("done", result);
      } catch (e) {
        send("error", { error: (e as Error).message, status: (e as { status?: number }).status ?? 500 });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
