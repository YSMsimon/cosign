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

export type Actor = { memberId: string | null; permissions: readonly string[] };

/** Everything one run needs. `vm: false` skips the microVM (Grok Bot calls, folder-only work). */
export async function runContext(agent: AgentRow, ws: WorkspaceRow, actor: Actor, o: { taskId?: string | null; vm?: boolean } = {}) {
  const rules = rulesOf(agent);
  const abilities = effectiveAbilities(rules, { canRequestPayments: can(actor.permissions, "payments.request") });
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
    scope: { agentId: agent.id, workspaceId: ws.id, memberId: actor.memberId, taskId: o.taskId ?? null },
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
  o: { turnNote?: string; via?: "voice" } = {},
) {
  const key = `${agent.ref}:${thread}`;
  if (locks.has(key)) throw conflict("this conversation is already running a turn; wait for it to finish");
  locks.add(key);
  try {
    const { ctx, instructions } = await runContext(agent, ws, actor, { taskId });
    return await runAgentTurn({ ctx, instructions, prompt, thread, quiet: true, onEvent, turnNote: o.turnNote, via: o.via });
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

export function requireUse(m: Membership, agent: AgentRow) {
  if (!canUseAgent(accessOf(agent), memberAccess(m))) {
    throw forbidden(agent.visibility === "private" ? "only its creator can use a private agent" : "your role can't use this agent");
  }
}

/** The caller's own conversation with an agent (from the session file; never another member's). */
export function readThread(agent: AgentRow, memberId: string) {
  const f = join(sandboxPaths(agent.ref).base, "sessions", `${memberThread(memberId)}.json`);
  if (!existsSync(f)) return { runs: 0, contextTokens: 0, compactions: 0, messages: [] };
  const s = JSON.parse(readFileSync(f, "utf8")) as { runs: number; lastContextTokens: number; compactions: number; transcript: { kind: string; text?: string; name?: string; t: string; via?: string }[] };
  return {
    runs: s.runs,
    contextTokens: s.lastContextTokens,
    compactions: s.compactions,
    messages: s.transcript.map((e) => (e.kind === "tool" ? { kind: "tool", name: e.name, t: e.t } : { kind: e.kind, text: e.text, t: e.t, ...(e.via ? { via: e.via } : {}) })),
  };
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
