/**
 * Cosign backend API, mounted at /api/v1 (src/app/api/v1/[...path]/route.ts).
 * This table is the API reference: method, path, who may call it, and what it does.
 * Signed-in = wallet sign-in cookie. Bot endpoints use the per-task Bearer token from a Grok Bot webhook;
 * the voice custom-LLM endpoint uses the voice session's token (X-Cosign-Auth), and the voice webhook is
 * HMAC-signed by ElevenLabs.
 */
import { after } from "next/server";
import { z } from "zod";
import { clearCookie, createNonce, endSession, sessionCookie, verifySignIn } from "../auth";
import { activityBus } from "../activity/store";
import type { ProposalDrafted } from "../agent/controls";
import type { ActivityRow } from "../db/schema";
import { requireAddress, requireAgentMember, requireMember, type Membership } from "./access";
import { agentDetail, agentView, createAgent, listAgents, onchainStatus, requireSee, retireAgent, sweepAgent, updateAgent } from "./agents";
import { memberThread, readThread, requireUse, runTurn, sseTurn } from "./chat";
import { botContext, botTool, callback, connect, connectionOf, connectionView, disconnect, listTasks, publicBase, requireConnectRight, setupMessage, startTask, taskForToken, taskView } from "./grokbot";
import { badRequest, errorResponse, forbidden, HttpError, notFound, parseBody } from "./http";
import { activityMatcher, approverChangeTx, cancelTx, cosignTx, decideApproval, listApprovals, listProposals, workspaceActivity } from "./money";
import { createSchedule, deleteSchedule, listSchedules, tick, updateSchedule } from "./schedules";
import { listFundingRequests, openOnramp } from "./funding";
import { agentSpend, workspaceSpend } from "./spend";
import { handleMcp, issueMcpToken, mcpStatus, revokeMcpTokens } from "./mcp";
import { listTeam } from "./team";
import { listTeamMessages, type TeamMessageEvent } from "./team-feed";
import { safeEqual } from "./util";
import { postCall, startVoice, voiceLlm, voiceStatus, voiceTaskFor } from "./voice";
import {
  addContact, createRole, createWorkspace, deleteRole, inviteMember, listContacts, listMembers, listRoles, myWorkspaces, prepareCreate, removeContact,
  removeMember, updateMember, updateRole, workspaceDetail,
} from "./workspaces";
import { db, schema } from "../db";
import { eq } from "drizzle-orm";

type Params = Record<string, string>;
type Handler = (req: Request, p: Params) => Promise<Response | unknown> | Response | unknown;
type Route = { method: string; path: string; handler: Handler };

const name = z.string().trim().min(1).max(80);
const text = z.string().trim().min(1).max(8000);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "wallet address");
const origin = (req: Request) => new URL(req.url).origin;

const routes: Route[] = [];
const route = (method: string, path: string, handler: Handler) => routes.push({ method, path, handler });

// ───────────── sign-in ─────────────
route("GET", "/auth/nonce", () => ({ nonce: createNonce() }));
route("POST", "/auth/verify", async (req) => {
  const b = await parseBody(req, z.object({ message: z.string().min(1).max(4000), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }));
  const host = req.headers.get("host") ?? new URL(req.url).host;
  const s = await verifySignIn(b.message, b.signature, host);
  return Response.json(
    { address: s.address, workspaces: myWorkspaces(s.address.toLowerCase()) },
    { headers: { "set-cookie": sessionCookie(s.token, s.expiresAt, new URL(req.url).protocol === "https:") } },
  );
});
route("POST", "/auth/logout", (req) => {
  endSession(req);
  return Response.json({ ok: true }, { headers: { "set-cookie": clearCookie() } });
});
route("GET", "/me", (req) => {
  const a = requireAddress(req);
  return { address: a, workspaces: myWorkspaces(a) };
});

// ───────────── workspaces ─────────────
route("POST", "/workspaces/prepare", async (req) => {
  const a = requireAddress(req);
  const b = await parseBody(req, z.object({ name, approvers: z.array(address).max(10).optional(), threshold: z.number().int().min(1).max(10).optional() }));
  return { tx: prepareCreate(a, b), next: "send this from your wallet, then POST /workspaces with { name, txHash }" };
});
route("POST", "/workspaces", async (req) => {
  const a = requireAddress(req);
  const b = await parseBody(req, z.object({ name, txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(), treasury: address.optional(), title: z.string().max(60).optional() }));
  const ws = await createWorkspace(a, b);
  return Response.json({ workspace: ws }, { status: 201 });
});
route("GET", "/workspaces/:ws", (req, p) => workspaceDetail(requireMember(req, p.ws)));

// members (invite by wallet address = access when that wallet signs in)
route("GET", "/workspaces/:ws/members", (req, p) => listMembers(requireMember(req, p.ws)));
route("POST", "/workspaces/:ws/members", async (req, p) => {
  const m = requireMember(req, p.ws, "members.manage");
  const b = await parseBody(req, z.object({ address, roleId: z.string(), title: z.string().max(60).nullish() }));
  return Response.json({ member: inviteMember(m, b) }, { status: 201 });
});
route("PATCH", "/workspaces/:ws/members/:mid", async (req, p) => {
  const m = requireMember(req, p.ws, "members.manage");
  return { member: updateMember(m, p.mid, await parseBody(req, z.object({ roleId: z.string().optional(), title: z.string().max(60).nullish() }))) };
});
route("DELETE", "/workspaces/:ws/members/:mid", (req, p) => removeMember(requireMember(req, p.ws, "members.manage"), p.mid));

// roles (two fixed major roles + member-level roles)
route("GET", "/workspaces/:ws/roles", (req, p) => ({ roles: listRoles(requireMember(req, p.ws)) }));
route("POST", "/workspaces/:ws/roles", async (req, p) => {
  const m = requireMember(req, p.ws, "roles.manage");
  return Response.json({ role: createRole(m, await parseBody(req, z.object({ name, permissions: z.array(z.string()) }))) }, { status: 201 });
});
route("PATCH", "/workspaces/:ws/roles/:rid", async (req, p) => {
  const m = requireMember(req, p.ws, "roles.manage");
  return { role: updateRole(m, p.rid, await parseBody(req, z.object({ name: name.optional(), permissions: z.array(z.string()).optional() }))) };
});
route("DELETE", "/workspaces/:ws/roles/:rid", (req, p) => deleteRole(requireMember(req, p.ws, "roles.manage"), p.rid));

// saved payees
route("GET", "/workspaces/:ws/contacts", (req, p) => ({ contacts: listContacts(requireMember(req, p.ws, "treasury.view").workspace.id) }));
route("POST", "/workspaces/:ws/contacts", async (req, p) => {
  const m = requireMember(req, p.ws, "contacts.manage");
  return Response.json({ contact: addContact(m, await parseBody(req, z.object({ name, address, notes: z.string().max(400).nullish() }))) }, { status: 201 });
});
route("DELETE", "/workspaces/:ws/contacts/:cid", (req, p) => removeContact(requireMember(req, p.ws, "contacts.manage"), p.cid));

// proposals and cosigning (prepared transactions for the approver's own wallet)
route("GET", "/workspaces/:ws/proposals", (req, p) => listProposals(requireMember(req, p.ws, "treasury.view"), { status: new URL(req.url).searchParams.get("status") === "open" ? "open" : "all" }));
route("GET", "/workspaces/:ws/proposals/:pid/cosign", async (req, p) => ({ tx: await cosignTx(requireMember(req, p.ws), Number(p.pid)) }));
route("GET", "/workspaces/:ws/proposals/:pid/cancel", async (req, p) => ({ tx: await cancelTx(requireMember(req, p.ws), Number(p.pid)) }));
route("POST", "/workspaces/:ws/approver-changes", async (req, p) => {
  const m = requireMember(req, p.ws);
  const b = await parseBody(req, z.object({ kind: z.enum(["add", "remove", "threshold"]), address: address.optional(), newThreshold: z.number().int().min(1).max(20).optional(), memo: z.string().max(200).optional() }));
  return { tx: await approverChangeTx(m, b), next: "send it from your wallet; it executes after enough approvers cosign it" };
});

// "ask a person" purchase approvals
route("GET", "/workspaces/:ws/approvals", (req, p) => ({ approvals: listApprovals(requireMember(req, p.ws), new URL(req.url).searchParams.get("status") ?? "pending") }));
route("POST", "/workspaces/:ws/approvals/:rid", async (req, p) => {
  const m = requireMember(req, p.ws);
  const b = await parseBody(req, z.object({ decision: z.enum(["approve", "deny"]) }));
  return { approval: decideApproval(m, p.rid, b.decision) };
});

// activity (QuickNode Stream → our DB), live feed
route("GET", "/workspaces/:ws/activity", (req, p) => {
  const m = requireMember(req, p.ws, "treasury.view");
  return { activity: workspaceActivity(m, Number(new URL(req.url).searchParams.get("limit") ?? 50)).map((r) => ({ ...r, raw: undefined })) };
});
route("GET", "/workspaces/:ws/activity/stream", (req, p) => activityStream(req, requireMember(req, p.ws, "treasury.view")));
route("GET", "/workspaces/:ws/tasks", (req, p) => {
  const m = requireMember(req, p.ws);
  const visible = listAgents(m).map((a) => a.id);
  return { tasks: listTasks(m.workspace.id, visible) };
});

// team: who agents can work with, and the feed of @mentions between agents and people (agents post with the mention tool)
route("GET", "/workspaces/:ws/team", (req, p) => {
  const m = requireMember(req, p.ws);
  return listTeam({ workspaceId: m.workspace.id, memberId: m.member.id });
});
route("GET", "/workspaces/:ws/team/messages", (req, p) => {
  const m = requireMember(req, p.ws);
  return { messages: listTeamMessages(m.workspace.id, Number(new URL(req.url).searchParams.get("limit") ?? 100)) };
});

// ───────────── agents ─────────────
route("GET", "/workspaces/:ws/agents", (req, p) => ({ agents: listAgents(requireMember(req, p.ws)) }));
// what agents spent (the rows the limits read), for the quota tiles and charts
route("GET", "/workspaces/:ws/spend", (req, p) => {
  const m = requireMember(req, p.ws, "treasury.view");
  return workspaceSpend(listAgents(m), Number(new URL(req.url).searchParams.get("days") ?? 30));
});
route("GET", "/agents/:ag/spend", (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  requireSee(m, agent);
  return agentSpend(agent.id, Number(new URL(req.url).searchParams.get("days") ?? 30));
});
route("POST", "/workspaces/:ws/agents", async (req, p) => {
  const m = requireMember(req, p.ws);
  const b = await parseBody(
    req,
    z.object({ name, prompt: text, visibility: z.enum(["private", "team"]), preset: z.enum(["readonly", "buyer", "clerk"]).optional(), allowedRoleIds: z.array(z.string()).nullish(), controls: z.record(z.string(), z.unknown()).optional(), hue: z.enum(["violet", "pink", "orange", "blue", "teal"]).optional() }),
  );
  const a = await createAgent(m, b);
  return Response.json({ agent: agentView(a, m) }, { status: 201 });
});
route("GET", "/agents/:ag", async (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  return { agent: await agentDetail(m, agent) };
});
route("PATCH", "/agents/:ag", async (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  const b = await parseBody(
    req,
    z.object({ name: name.optional(), prompt: text.optional(), visibility: z.enum(["private", "team"]).optional(), allowedRoleIds: z.array(z.string()).nullish(), abilities: z.record(z.string(), z.unknown()).optional(), controls: z.record(z.string(), z.unknown()).optional() }),
  );
  return { agent: updateAgent(m, agent, b) };
});
route("POST", "/agents/:ag/freeze", (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  return { agent: updateAgent(m, agent, { controls: { frozen: true } }) };
});
route("POST", "/agents/:ag/unfreeze", (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  return { agent: updateAgent(m, agent, { controls: { frozen: false } }) };
});
route("POST", "/agents/:ag/sweep", async (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  requireSee(m, agent);
  return sweepAgent(m, agent);
});
route("POST", "/agents/:ag/retire", async (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  return retireAgent(m, agent);
});
route("GET", "/agents/:ag/onchain", async (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  requireSee(m, agent);
  return onchainStatus(m, agent);
});

// chat: Server-Sent Events (step events while the agent works, then done)
route("POST", "/agents/:ag/chat", async (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  requireUse(m, agent);
  const b = await parseBody(req, z.object({ message: text }));
  return sseTurn((onEvent) =>
    runTurn(agent, m.workspace, { memberId: m.member.id, permissions: m.permissions }, memberThread(m.member.id), b.message, onEvent).then((r) => ({
      finalText: r.finalText,
      totals: r.totals,
      estCostUsd: r.estCostUsd,
      session: r.session,
      runId: r.runId,
    })),
  );
});
route("GET", "/agents/:ag/thread", (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  requireUse(m, agent);
  return readThread(agent, m.member.id);
});

// Grok Bot (webhook routine) and background tasks
route("GET", "/agents/:ag/grokbot", (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  requireSee(m, agent);
  return { connection: connectionView(connectionOf(agent.id)), setupMessage: setupMessage(agent, m.workspace, publicBase(origin(req))) };
});
route("POST", "/agents/:ag/grokbot", async (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  requireConnectRight(m, agent);
  const b = await parseBody(req, z.object({ webhookUrl: z.string().url(), webhookKey: z.string().min(8).max(500), waitMs: z.number().int().min(0).max(30_000).optional() }));
  return connect(m, agent, b, publicBase(origin(req)), b.waitMs);
});
route("DELETE", "/agents/:ag/grokbot", (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  return disconnect(m, agent);
});
route("POST", "/agents/:ag/tasks", async (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  requireUse(m, agent);
  const b = await parseBody(req, z.object({ instructions: text }));
  const { task, runLater } = await startTask(agent, m.workspace, { kind: "task", source: "member", instructions: b.instructions, requestedBy: m.member.id, base: publicBase(origin(req)) });
  if (runLater) after(runLater);
  return Response.json({ task: taskView(task) }, { status: 202 });
});
route("GET", "/tasks/:tid", (req, p) => {
  const t = db().select().from(schema.tasks).where(eq(schema.tasks.id, p.tid)).get();
  if (!t) throw notFound("task not found");
  const { m, agent } = requireAgentMember(req, t.agentId);
  requireSee(m, agent);
  return { task: taskView(t) };
});

// money in: an approver opens Circle's onramp for the treasury (from an agent's funding request, or on their own)
route("GET", "/workspaces/:ws/funding-requests", (req, p) => ({ requests: listFundingRequests(requireMember(req, p.ws).workspace.id) }));
route("POST", "/workspaces/:ws/onramp", async (req, p) => {
  const m = requireMember(req, p.ws);
  const b = await parseBody(req, z.object({ requestId: z.string().optional(), amountUsd: z.number().positive().max(10_000).optional() }));
  return openOnramp(m, b);
});

// MCP: Cosign's tools for Grok Bot's "Add a custom MCP" (URL + Authorization header with a connector token)
route("POST", "/mcp", (req) => handleMcp(req));
route("GET", "/mcp", () => new Response(null, { status: 405, headers: { Allow: "POST" } }));
route("DELETE", "/mcp", () => new Response(null, { status: 405, headers: { Allow: "POST" } }));
route("GET", "/agents/:ag/mcp-token", (req, p) => {
  const { agent } = requireAgentMember(req, p.ag);
  return mcpStatus(agent.id);
});
route("POST", "/agents/:ag/mcp-token", (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  const t = issueMcpToken(m, agent);
  return { url: `${publicBase(origin(req))}/api/v1/mcp`, header: "Authorization", value: `Bearer ${t.token}`, expiresAt: t.expiresAt, note: "shown once; paste the URL and this header into Grok Bot → Add a custom MCP" };
});
route("DELETE", "/agents/:ag/mcp-token", (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  return revokeMcpTokens(m, agent);
});

// schedules (stored here; due ones go to Grok Bot, or our own loop when no Bot is connected)
route("GET", "/agents/:ag/schedules", (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  requireSee(m, agent);
  return { schedules: listSchedules(agent.id) };
});
const specSchema = z.object({ every: z.enum(["hour", "day", "week"]), minute: z.number().int().optional(), hour: z.number().int().nullish(), weekday: z.number().int().nullish() });
route("POST", "/agents/:ag/schedules", async (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  const b = await parseBody(req, z.object({ name, instructions: text, spec: specSchema, enabled: z.boolean().optional() }));
  return Response.json({ schedule: createSchedule(m, agent, b) }, { status: 201 });
});
route("PATCH", "/schedules/:sid", async (req, p) => {
  const s = db().select().from(schema.schedules).where(eq(schema.schedules.id, p.sid)).get();
  if (!s) throw notFound("schedule not found");
  const m = requireMember(req, s.workspaceId);
  const b = await parseBody(req, z.object({ name: name.optional(), instructions: text.optional(), spec: specSchema.optional(), enabled: z.boolean().optional(), nextRunAt: z.string().optional() }));
  return { schedule: updateSchedule(m, p.sid, b) };
});
route("DELETE", "/schedules/:sid", (req, p) => {
  const s = db().select().from(schema.schedules).where(eq(schema.schedules.id, p.sid)).get();
  if (!s) throw notFound("schedule not found");
  return deleteSchedule(requireMember(req, s.workspaceId), p.sid);
});
route("POST", "/cron/tick", async (req) => {
  const secret = process.env.CRON_SECRET ?? "";
  const given = req.headers.get("x-cron-secret") ?? (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!secret || !safeEqual(given, secret)) throw new HttpError(401, "bad cron secret");
  const { ran, later } = await tick(publicBase(origin(req)));
  for (const fn of later) after(fn);
  return { ran };
});

// ───────────── Grok Bot side (Bearer = the task's token) ─────────────
route("GET", "/bot/context", (req) => botContext(taskForToken(req)));
route("POST", "/bot/tools/:name", async (req, p) => {
  const task = taskForToken(req);
  const b = await parseBody(req, z.object({ args: z.record(z.string(), z.unknown()).default({}) }));
  return botTool(task, p.name, b.args);
});
for (const kind of ["ack", "progress", "result"] as const) {
  route("POST", `/bot/tasks/:tid/${kind}`, async (req, p) => {
    const task = taskForToken(req);
    if (task.id !== p.tid) throw forbidden("token belongs to another task");
    const b = await parseBody(req, z.object({ note: z.string().max(2000).optional(), message: z.string().max(2000).optional(), result: z.string().max(20000).optional(), error: z.string().max(2000).optional() }));
    return { task: taskView(callback(task, kind, b)) };
  });
}

// ───────────── ElevenLabs voice ─────────────
// Start: a member who may use the agent gets a signed URL and the conversation's dynamic variables.
route("GET", "/agents/:ag/voice", (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  requireSee(m, agent);
  return voiceStatus(agent);
});
route("POST", "/agents/:ag/voice", async (req, p) => {
  const { m, agent } = requireAgentMember(req, p.ag);
  requireUse(m, agent);
  return Response.json(await startVoice(m, agent), { status: 201, headers: { "cache-control": "no-store" } });
});
// ElevenLabs' custom LLM: every spoken turn is answered by our loop (X-Cosign-Auth = the voice session's token).
// Both paths, since ElevenLabs may call the configured URL as-is or append /chat/completions to it.
const voiceTurn = async (req: Request) => {
  const task = voiceTaskFor(req);
  const raw = await req.text();
  let body: unknown;
  try {
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw badRequest("body must be JSON");
  }
  return voiceLlm(task, body, { signal: req.signal });
};
route("POST", "/voice/llm", voiceTurn);
route("POST", "/voice/llm/chat/completions", voiceTurn);
// ElevenLabs' post-call webhook (HMAC-signed with the secret saved by `pnpm voice setup`).
route("POST", "/voice/webhook", async (req) => postCall(await req.text(), req.headers.get("elevenlabs-signature")));

// ───────────── dispatch ─────────────
function match(path: string, pattern: string): Params | null {
  const a = path.split("/").filter(Boolean);
  const b = pattern.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Params = {};
  for (let i = 0; i < b.length; i++) {
    if (b[i].startsWith(":")) params[b[i].slice(1)] = decodeURIComponent(a[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export async function handle(req: Request, segments: string[]): Promise<Response> {
  const path = "/" + segments.join("/");
  let allowed = false;
  for (const r of routes) {
    const p = match(path, r.path);
    if (!p) continue;
    allowed = true;
    if (r.method !== req.method) continue;
    try {
      const out = await r.handler(req, p);
      return out instanceof Response ? out : Response.json(out);
    } catch (e) {
      return errorResponse(e);
    }
  }
  return errorResponse(allowed ? new HttpError(405, `method ${req.method} not allowed here`) : notFound(`no route ${req.method} ${path}`));
}

export const routeTable = () => routes.map((r) => `${r.method.padEnd(6)} /api/v1${r.path}`);

// live feed for one workspace
function activityStream(req: Request, m: Membership): Response {
  const matches = activityMatcher(m);
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const onActivity = (row: ActivityRow) => {
        if (matches(row)) send("activity", { ...row, raw: undefined, explorer: `https://explorer.testnet.arc.io/tx/${row.txHash}` });
      };
      // an agent drafted a payment in this workspace (chat, voice or Grok Bot); taskId names the voice session or task
      const onDraft = (d: ProposalDrafted) => {
        if (d.workspaceId === m.workspace.id) send("proposal.drafted", d);
      };
      // an agent @mentioned a teammate or a person, or a mentioned agent answered
      const onTeam = (e: TeamMessageEvent) => {
        if (e.workspaceId === m.workspace.id) send("team.message", e.message);
      };
      activityBus.on("activity", onActivity);
      activityBus.on("proposal.drafted", onDraft);
      activityBus.on("team.message", onTeam);
      const ping = setInterval(() => controller.enqueue(enc.encode(`: ping\n\n`)), 15_000);
      send("ready", { at: new Date().toISOString() });
      cleanup = () => {
        clearInterval(ping);
        activityBus.off("activity", onActivity);
        activityBus.off("proposal.drafted", onDraft);
        activityBus.off("team.message", onTeam);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}

