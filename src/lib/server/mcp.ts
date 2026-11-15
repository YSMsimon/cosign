/**
 * Cosign's tools over MCP, for Grok Bot's "Add a custom MCP" (a server URL plus an Authorization header).
 * Streamable HTTP with plain JSON answers and no sessions: POST /api/v1/mcp carries one JSON-RPC message (or a
 * batch); GET is not offered (no server-to-client stream). Methods: initialize, ping, tools/list, tools/call.
 *
 * The header holds a connector token for ONE agent (the agent the Grok Bot routine works as), issued by a member
 * who may connect Grok Bot for it, revocable, 30 days. Every call runs through the same checked tool runner and
 * the same tool set as the webhook tool API (BOT_TOOLS: no microVM tools). While a webhook task for that agent is
 * open, calls belong to it: they act under the rights of the person who asked for that task, and mentions join
 * its chain. Grok Bot passes the task's id as `task_id` (every tool accepts it); without it the agent's newest
 * open task is used, and with no open task the call acts for the member who issued the token.
 * Server-only.
 */
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { runToolChecked, toolsFor } from "../agent/tools";
import { db, schema } from "../db";
import type { AgentRow, TaskRow } from "../db/schema";
import type { Membership } from "./access";
import { runContext } from "./chat";
import { actorFor, BOT_TOOLS, recordToolCall, requireConnectRight } from "./grokbot";
import { HttpError } from "./http";
import { id, newToken, sha256 } from "./util";

export const MCP_PROTOCOL = "2025-06-18";
const SUPPORTED = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const TOKEN_DAYS = 30;
const OPEN_TASK = ["sent", "acked", "working"];
const now = () => new Date().toISOString();

// ───────────── connector tokens ─────────────

/** A new connector token for this agent; older ones stop working. Shown once (the caller copies it into Grok Bot). */
export function issueMcpToken(m: Membership, agent: AgentRow) {
  requireConnectRight(m, agent);
  revokeMcpTokens(m, agent);
  const token = `cmcp_${newToken()}`;
  const expiresAt = new Date(Date.now() + TOKEN_DAYS * 86_400_000).toISOString();
  db().insert(schema.mcpTokens).values({ id: id("mcp"), workspaceId: agent.workspaceId, agentId: agent.id, memberId: m.member.id, tokenHash: sha256(token), createdAt: now(), expiresAt, revokedAt: null, lastUsedAt: null }).run();
  return { token, expiresAt };
}

export function revokeMcpTokens(m: Membership, agent: AgentRow) {
  requireConnectRight(m, agent);
  db().update(schema.mcpTokens).set({ revokedAt: now() }).where(and(eq(schema.mcpTokens.agentId, agent.id), isNull(schema.mcpTokens.revokedAt))).run();
  return { revoked: true };
}

export function mcpStatus(agentId: string) {
  const t = db().select().from(schema.mcpTokens).where(and(eq(schema.mcpTokens.agentId, agentId), isNull(schema.mcpTokens.revokedAt), gt(schema.mcpTokens.expiresAt, now()))).orderBy(desc(schema.mcpTokens.createdAt)).get();
  return t ? { status: "issued", expiresAt: t.expiresAt, lastUsedAt: t.lastUsedAt } : { status: "none" };
}

function caller(req: Request) {
  const h = req.headers.get("authorization") ?? "";
  const token = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "missing bearer token");
  const t = db()
    .select()
    .from(schema.mcpTokens)
    .where(and(eq(schema.mcpTokens.tokenHash, sha256(token)), isNull(schema.mcpTokens.revokedAt), gt(schema.mcpTokens.expiresAt, now())))
    .get();
  if (!t) throw new HttpError(401, "token unknown, revoked or expired");
  const agent = db().select().from(schema.agents).where(eq(schema.agents.id, t.agentId)).get();
  const ws = db().select().from(schema.workspaces).where(eq(schema.workspaces.id, t.workspaceId)).get();
  if (!agent || !ws || agent.status !== "active") throw new HttpError(403, "the agent behind this token is not available");
  const stillMember = db().select().from(schema.members).where(eq(schema.members.id, t.memberId)).get();
  if (!stillMember) throw new HttpError(403, "the member who issued this token has left the workspace");
  db().update(schema.mcpTokens).set({ lastUsedAt: now() }).where(eq(schema.mcpTokens.id, t.id)).run();
  return { token: t, agent, ws };
}

/** The open webhook task a call belongs to: the one named by task_id, else the agent's newest open one. */
function openTask(agentId: string, taskId: unknown): TaskRow | undefined {
  const base = and(eq(schema.tasks.agentId, agentId), inArray(schema.tasks.status, OPEN_TASK), gt(schema.tasks.tokenExpiresAt, now()));
  if (typeof taskId === "string" && taskId) return db().select().from(schema.tasks).where(and(base, eq(schema.tasks.id, taskId))).get();
  return db().select().from(schema.tasks).where(base).orderBy(desc(schema.tasks.updatedAt)).get();
}

// ───────────── JSON-RPC ─────────────

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const TASK_ID = { type: "string", description: "The id of the Cosign job you are working on (task_id in the webhook request), so this call counts for that job." };
const withTaskId = (p: Record<string, unknown>) => ({ ...p, properties: { ...((p.properties as object) ?? {}), task_id: TASK_ID } });
const ok = (rid: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id: rid, result });
const fail = (rid: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: rid ?? null, error: { code, message } });

const INSTRUCTIONS =
  "Cosign's tools for this agent: balances, proposals, allowed payees and sellers, paid APIs, drafting treasury payments (a person always cosigns), " +
  "petty cash, memory notes, and the team (list_team, mention). Every call is checked against the agent's rules; a refused call explains why: report it, don't retry it. " +
  "When you work on a Cosign job, pass its task_id with every call.";

async function answer(c: ReturnType<typeof caller>, msg: Rpc) {
  const rid = msg.id;
  const params = msg.params ?? {};
  switch (msg.method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return ok(rid, {
        protocolVersion: SUPPORTED.has(asked) ? asked : MCP_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "cosign", title: `Cosign (${c.agent.name}, ${c.ws.name})`, version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(rid, {});
    case "tools/list": {
      const actor = actorFor(c.token.memberId);
      const { ctx } = await runContext(c.agent, c.ws, actor, { vm: false });
      const tools = toolsFor(ctx, BOT_TOOLS).map((t) => ({ name: t.name, description: t.description, inputSchema: withTaskId(t.parameters) }));
      return ok(rid, { tools });
    }
    case "tools/call": {
      const name = String(params.name ?? "");
      const args = { ...((params.arguments as Record<string, unknown>) ?? {}) };
      const task = openTask(c.agent.id, args.task_id);
      delete args.task_id;
      // inside a job: the rights of the person who asked for it, and the job's chain; outside: the token's member
      const actor = actorFor(task ? task.requestedBy : c.token.memberId);
      const { ctx } = await runContext(c.agent, c.ws, actor, { taskId: task?.id ?? null, vm: false });
      const res = await runToolChecked(ctx, name, args, BOT_TOOLS);
      if (task) recordToolCall(task.id, `${name} (MCP)`, res);
      if (res.status === "error" && res.error === "unknown tool") return fail(rid, -32602, `unknown tool: ${name}`);
      return ok(rid, { content: [{ type: "text", text: JSON.stringify(res.output) }], isError: res.status !== "ok" });
    }
    default:
      return fail(rid, -32601, `method not found: ${msg.method}`);
  }
}

/** POST /api/v1/mcp */
export async function handleMcp(req: Request): Promise<Response> {
  let c: ReturnType<typeof caller>;
  try {
    c = caller(req);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 401;
    return Response.json(fail(null, -32001, (e as Error).message), { status, headers: status === 401 ? { "WWW-Authenticate": 'Bearer realm="cosign"' } : undefined });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(fail(null, -32700, "parse error"), { status: 400 });
  }
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as Rpc[];
  if (!msgs.length || msgs.some((m) => !m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string")) {
    return Response.json(fail(null, -32600, "invalid request"), { status: 400 });
  }
  const out = [];
  for (const m of msgs) {
    if (m.id === undefined) continue; // notifications (e.g. notifications/initialized) get no answer
    try {
      out.push(await answer(c, m));
    } catch (e) {
      out.push(fail(m.id, -32603, (e as Error).message));
    }
  }
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(batch ? out : out[0]);
}
