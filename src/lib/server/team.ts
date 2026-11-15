/**
 * Agents work as a team. Any agent (ours, or Grok Bot through its tool API) can:
 *   - list_team: see who it can work with (people, and agents with what they do, live or background, busy or not);
 *   - mention: post a message with a real @mention (by id, never by parsing text). Mentioning an agent starts a
 *     task for it, under the rights of the same person the mentioning agent works for; mentioning a person
 *     notifies them in the team feed. When the mentioned agent finishes, its answer is posted back (team-feed.ts).
 *
 * Guards, so agents can't loop or run away (a chain = hand-offs since a person or a schedule started the work):
 *   - one agent can ask the same agent at most MAX_ASKS_PER_PAIR times in a chain (the first ask and 2 retries);
 *   - at most MAX_CHAIN_HOPS agent-to-agent hand-offs in a chain without a person (a backstop for longer loops);
 *   - an agent can't mention itself, and only agents the person may use can be woken;
 *   - money still ends at a person's approval: a mention never approves or signs anything.
 * Server-only.
 */
import { and, eq, gt, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import type { AgentRow, MemberRow, WorkspaceRow } from "../db/schema";
import { canUseAgent, type MemberAccess } from "../perm/permissions";
import { accessOf } from "./agents";
import { connectionOf, publicBase, startTask } from "./grokbot";
import { mentionForTask, postTeamMessage } from "./team-feed";
import { id } from "./util";

export const MAX_ASKS_PER_PAIR = 3;
export const MAX_CHAIN_HOPS = 6;
const BUSY_WINDOW_MS = 30 * 60_000;

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const personName = (m: MemberRow) => m.title?.trim() || shortAddr(m.address);

function memberAccessFor(memberId: string | null): MemberAccess | null {
  if (!memberId) return null;
  const row = db()
    .select({ id: schema.members.id, roleId: schema.members.roleId, perms: schema.roles.permissions })
    .from(schema.members)
    .innerJoin(schema.roles, eq(schema.members.roleId, schema.roles.id))
    .where(eq(schema.members.id, memberId))
    .get();
  return row ? { id: row.id, roleId: row.roleId, permissions: JSON.parse(row.perms) as string[] } : null;
}

/** May the person this run works for wake that agent? Runs with no person (schedules) may only wake open team agents. */
function mayWake(agent: AgentRow, access: MemberAccess | null) {
  if (agent.status !== "active") return false;
  if (access) return canUseAgent(accessOf(agent), access);
  return agent.visibility === "team" && !agent.allowedRoleIds;
}

const isBackground = (agentId: string) => connectionOf(agentId)?.status === "connected";

function busyAgents(workspaceId: string): Set<string> {
  const since = new Date(Date.now() - BUSY_WINDOW_MS).toISOString();
  const rows = db()
    .select({ agentId: schema.tasks.agentId })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.workspaceId, workspaceId), inArray(schema.tasks.status, ["queued", "sent", "acked", "working"]), gt(schema.tasks.updatedAt, since)))
    .all();
  return new Set(rows.map((r) => r.agentId));
}

/** Everyone an agent can work with, as the person it works for sees them. */
export function listTeam(o: { workspaceId: string; memberId: string | null; selfAgentId?: string | null }) {
  const access = memberAccessFor(o.memberId);
  const people = db()
    .select({ m: schema.members, roleName: schema.roles.name })
    .from(schema.members)
    .innerJoin(schema.roles, eq(schema.members.roleId, schema.roles.id))
    .where(eq(schema.members.workspaceId, o.workspaceId))
    .all()
    .map(({ m, roleName }) => ({ kind: "person" as const, id: m.id, name: personName(m), role: roleName, address: m.address }));
  const busy = busyAgents(o.workspaceId);
  const agents = db()
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.workspaceId, o.workspaceId), eq(schema.agents.status, "active")))
    .all()
    .filter((a) => a.id === o.selfAgentId || mayWake(a, access))
    .map((a) => ({
      kind: "agent" as const,
      id: a.id,
      name: a.name,
      job: a.prompt.length > 160 ? `${a.prompt.slice(0, 157)}…` : a.prompt,
      runs: isBackground(a.id) ? "background (Grok Bot)" : "live",
      busy: busy.has(a.id),
      ...(a.id === o.selfAgentId ? { you: true } : {}),
    }));
  return {
    people,
    agents,
    grokBot: {
      name: "Grok Bot",
      does: "runs a job for you in the background (on your Grok Bot routine when one is connected); hand it work with mention(who: 'Grok Bot')",
      connected: !!(o.selfAgentId && connectionOf(o.selfAgentId)?.status === "connected"),
    },
    howTo: `Use mention with a name or id from this list. Mention only when something is wrong or needs someone; when work went fine, just report. You can ask the same agent ${MAX_ASKS_PER_PAIR} times in one chain (the first ask and 2 retries), and a chain stops after ${MAX_CHAIN_HOPS} agent hand-offs without a person: then mention a person.`,
  };
}

type Target = { kind: "agent"; agent: AgentRow } | { kind: "member"; member: MemberRow };

/** A teammate by id or name (agents by name, people by title or wallet address). */
function resolve(workspaceId: string, who: string): Target | null {
  const w = who.trim().replace(/^@/, "");
  const lower = w.toLowerCase();
  if (!w) return null;
  const agents = db().select().from(schema.agents).where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.status, "active"))).all();
  const agent = agents.find((a) => a.id === w) ?? agents.find((a) => a.name.toLowerCase() === lower);
  if (agent) return { kind: "agent", agent };
  const members = db().select().from(schema.members).where(eq(schema.members.workspaceId, workspaceId)).all();
  const member = members.find((m) => m.id === w || m.address === lower || (m.title ?? "").toLowerCase() === lower);
  return member ? { kind: "member", member } : null;
}

export type MentionInput = { workspaceId: string; fromAgentId: string; memberId: string | null; fromTaskId?: string | null; who: string; message: string; base?: string };
export type MentionResult =
  | { refused: true; reason: string }
  | { posted: { id: string; to: { kind: "agent" | "person" | "grokbot"; id: string; name: string } }; task?: { id: string; engine: string; status: string; error?: string | null }; note?: string };

/**
 * Post a mention and, for an agent, start its task. Returns `runLater` when the task runs on our own loop (no Grok
 * Bot connected); the caller starts it (the agent tool does, without waiting; tests don't).
 */
export async function mention(o: MentionInput): Promise<{ result: MentionResult; runLater?: () => Promise<void> }> {
  const refuse = (reason: string) => ({ result: { refused: true as const, reason } });
  const message = o.message.trim();
  if (!message) return refuse("the message is empty");
  if (message.length > 4000) return refuse("the message is too long (4000 characters at most)");
  const ws = db().select().from(schema.workspaces).where(eq(schema.workspaces.id, o.workspaceId)).get() as WorkspaceRow | undefined;
  const from = db().select().from(schema.agents).where(eq(schema.agents.id, o.fromAgentId)).get();
  if (!ws || !from) return refuse("this agent isn't in a workspace");
  const target = resolve(ws.id, o.who);
  // "Grok Bot" (when no teammate has that name): a background job for you, on your Grok Bot routine (our own loop when none is connected). It shows in
  // the person's chat with you as Grok Bot's turn, with its result.
  if (!target && /^@?grok\s*bot$/i.test(o.who.trim())) {
    const running = o.fromTaskId ? db().select().from(schema.tasks).where(eq(schema.tasks.id, o.fromTaskId)).get() : undefined;
    if (running?.engine === "grokbot") return refuse("you are already running on Grok Bot: do the work yourself");
    const { task, runLater } = await startTask(from, ws, { kind: "task", source: "agent", instructions: message, requestedBy: o.memberId, base: o.base ?? publicBase("http://localhost:3000") });
    if (task.status === "failed") return refuse(`couldn't start the Grok Bot job: ${task.error ?? "unknown error"}`);
    return {
      result: {
        posted: { id: task.id, to: { kind: "grokbot" as const, id: "grokbot", name: "Grok Bot" } },
        task: { id: task.id, engine: task.engine, status: task.status, error: task.error },
        note: "It runs in the background; its result shows in your chat with the person when it's done. Don't wait for it.",
      },
      runLater,
    };
  }
  if (!target) return refuse(`no teammate called "${o.who}": use list_team to see who you can mention`);
  if (target.kind === "agent" && target.agent.id === from.id) return refuse("you can't mention yourself");

  // the chain this run belongs to: started by a teammate's mention, or by a person (a new chain)
  const startedBy = o.fromTaskId ? mentionForTask(o.fromTaskId) : undefined;
  const rootId = startedBy?.rootId ?? id("chain");
  const depth = target.kind === "agent" ? (startedBy?.depth ?? 0) + 1 : (startedBy?.depth ?? 0);

  if (target.kind === "agent") {
    const asked = db()
      .select({ id: schema.teamMessages.id })
      .from(schema.teamMessages)
      .where(
        and(
          eq(schema.teamMessages.rootId, rootId),
          eq(schema.teamMessages.fromKind, "agent"),
          eq(schema.teamMessages.fromId, from.id),
          eq(schema.teamMessages.toKind, "agent"),
          eq(schema.teamMessages.toId, target.agent.id),
        ),
      )
      .all().length;
    if (asked >= MAX_ASKS_PER_PAIR) return refuse(`you've already asked ${target.agent.name} ${asked} times about this (the first ask and 2 retries): mention a person instead`);
    if (depth > MAX_CHAIN_HOPS) return refuse(`this has been handed between agents ${MAX_CHAIN_HOPS} times without a person: mention a person instead (list_team shows who)`);
    if (!mayWake(target.agent, memberAccessFor(o.memberId))) return refuse(`the person you work for can't use ${target.agent.name}, so you can't hand it work`);
  }

  const toName = target.kind === "agent" ? target.agent.name : personName(target.member);
  const posted = postTeamMessage({
    workspaceId: ws.id,
    fromKind: "agent",
    fromId: from.id,
    toKind: target.kind,
    toId: target.kind === "agent" ? target.agent.id : target.member.id,
    text: message,
    taskId: null,
    fromTaskId: o.fromTaskId ?? null,
    rootId,
    depth,
  });
  const to = { kind: target.kind === "agent" ? ("agent" as const) : ("person" as const), id: posted.toId!, name: toName };
  if (target.kind === "member") return { result: { posted: { id: posted.id, to } } };

  const instructions = [
    `${from.name} mentioned you in ${ws.name}:`,
    `"${message}"`,
    "Do what this asks, within your rules. When you're done, answer with a short result: it is posted back to the team.",
    "If something is wrong or you need someone else, use the mention tool (list_team shows who). If it went fine, don't mention anyone.",
  ].join("\n");
  const { task, runLater } = await startTask(target.agent, ws, {
    kind: "task",
    source: "agent",
    instructions,
    requestedBy: o.memberId,
    base: o.base ?? publicBase("http://localhost:3000"),
  });
  db().update(schema.teamMessages).set({ taskId: task.id }).where(eq(schema.teamMessages.id, posted.id)).run();
  // never silent: if the agent couldn't even be reached (e.g. its Grok Bot webhook failed), say so in the feed
  if (task.status === "failed")
    postTeamMessage({ workspaceId: ws.id, fromKind: "cosign", fromId: null, toKind: null, toId: null, text: `Couldn't start ${toName}: ${task.error ?? "unknown error"}`, taskId: null, fromTaskId: o.fromTaskId ?? null, rootId, depth });
  return { result: { posted: { id: posted.id, to }, task: { id: task.id, engine: task.engine, status: task.status, error: task.error } }, runLater };
}
