/**
 * Money in, agent-native: an agent that sees the treasury running short asks for funds (`request_funds`); a person
 * buys USDC into the treasury through Circle's onramp widget. The agent never sees the widget or any payment details,
 * and never chooses where the money goes: the session is always for the workspace treasury.
 *
 *   request_funds (agent tool)  → a funding request + an @mention of an approver in the team feed
 *   POST /workspaces/:ws/onramp → (an approver) a sandbox onramp session for the treasury → the widget URL
 * Server-only.
 */
import { and, desc, eq } from "drizzle-orm";
import type { Address } from "viem";
import { createOnrampSession } from "../appkit";
import { db, schema } from "../db";
import type { MemberRow } from "../db/schema";
import { can } from "../perm/permissions";
import type { Membership } from "./access";
import { forbidden, notFound } from "./http";
import { postTeamMessage } from "./team-feed";
import { id } from "./util";

const now = () => new Date().toISOString();
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Who may add funds: an approver (payments.cosign) or someone who manages the workspace. */
export const mayAddFunds = (perms: readonly string[]) => can(perms, "payments.cosign") || can(perms, "workspace.manage");

/** Approvers first, then workspace managers: the people an agent asks for money. */
function fundersOf(workspaceId: string): MemberRow[] {
  const rows = db()
    .select({ m: schema.members, perms: schema.roles.permissions })
    .from(schema.members)
    .innerJoin(schema.roles, eq(schema.members.roleId, schema.roles.id))
    .where(eq(schema.members.workspaceId, workspaceId))
    .all();
  const score = (p: string[]) => (can(p, "payments.cosign") ? 0 : can(p, "workspace.manage") ? 1 : 2);
  return rows
    .map((r) => ({ m: r.m, s: score(JSON.parse(r.perms) as string[]) }))
    .filter((r) => r.s < 2)
    .sort((a, b) => a.s - b.s)
    .map((r) => r.m);
}

/** The agent asks; a person decides. Returns who was asked, or a refusal. */
export function requestFunds(o: { workspaceId: string; agentId: string; memberId: string | null; taskId?: string | null; amountUsd: number; reason: string }) {
  if (!(o.amountUsd > 0) || o.amountUsd > 10_000) return { refused: true as const, reason: "amount must be more than $0 and at most $10,000" };
  const reason = o.reason.trim().slice(0, 500) || "the treasury is running short";
  const ws = db().select().from(schema.workspaces).where(eq(schema.workspaces.id, o.workspaceId)).get();
  if (!ws) return { refused: true as const, reason: "no workspace" };
  // the person the agent works for, when they may add funds themselves (they approve it on their screen); else someone who may
  const funders = fundersOf(ws.id);
  const asked = funders.find((m) => m.id === o.memberId) ?? funders[0];
  if (!asked) return { refused: true as const, reason: "nobody in this workspace may add funds" };
  const requestId = id("fund");
  db()
    .insert(schema.fundingRequests)
    .values({ id: requestId, workspaceId: ws.id, agentId: o.agentId, requestedBy: o.memberId, askedMemberId: asked.id, amountUsd: String(o.amountUsd), reason, status: "pending", sessionId: null, createdAt: now(), updatedAt: now() })
    .run();
  const who = asked.title?.trim() || shortAddr(asked.address);
  postTeamMessage({
    workspaceId: ws.id,
    fromKind: "agent",
    fromId: o.agentId,
    toKind: "member",
    toId: asked.id,
    // for a person: the amount and why (the card in the chat carries the request itself)
    text: `The treasury needs about $${o.amountUsd.toFixed(2)}: ${reason.replace(/[.\s]+$/, "")}. Add funds?`,
    taskId: null,
    fromTaskId: o.taskId ?? null,
    rootId: id("chain"),
    depth: 0,
  });
  return { requested: true as const, requestId, asked: who, amountUsd: o.amountUsd, note: "A person adds the funds through Circle's onramp; you can't, and you'll see the money arrive in the treasury." };
}

/** An approver opens the onramp: a session for the workspace treasury (never another address). */
export async function openOnramp(m: Membership, o: { requestId?: string; amountUsd?: number }) {
  if (!mayAddFunds(m.permissions)) throw forbidden("only an approver or a workspace manager can add funds");
  const req = o.requestId
    ? db().select().from(schema.fundingRequests).where(and(eq(schema.fundingRequests.id, o.requestId), eq(schema.fundingRequests.workspaceId, m.workspace.id))).get()
    : undefined;
  if (o.requestId && !req) throw notFound("no such funding request in this workspace");
  const amountUsd = o.amountUsd ?? (req ? Number(req.amountUsd) : undefined);
  const s = await createOnrampSession({ appUserId: m.member.id, destination: m.workspace.treasury as Address, amountUsd });
  if (req) db().update(schema.fundingRequests).set({ status: "opened", sessionId: s.sessionId, updatedAt: now() }).where(eq(schema.fundingRequests.id, req.id)).run();
  return { widgetUrl: s.widgetUrl, expiresAt: s.expiresAt, sandbox: s.sandbox, destination: m.workspace.treasury, requestId: req?.id ?? null };
}

export const listFundingRequests = (workspaceId: string) =>
  db().select().from(schema.fundingRequests).where(eq(schema.fundingRequests.workspaceId, workspaceId)).orderBy(desc(schema.fundingRequests.createdAt)).limit(50).all();

/** An approver says no to a funding request (nothing is bought; the agent sees it declined). */
export function declineFunding(m: Membership, requestId: string) {
  if (!mayAddFunds(m.permissions)) throw forbidden("only an approver or a workspace manager can decide on adding funds");
  const req = db().select().from(schema.fundingRequests).where(and(eq(schema.fundingRequests.id, requestId), eq(schema.fundingRequests.workspaceId, m.workspace.id))).get();
  if (!req) throw notFound("no such funding request in this workspace");
  db().update(schema.fundingRequests).set({ status: "declined", updatedAt: new Date().toISOString() }).where(eq(schema.fundingRequests.id, req.id)).run();
  return { ...req, status: "declined" };
}
