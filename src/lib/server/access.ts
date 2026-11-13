/**
 * Who is calling and what they may do in a workspace. Server-only.
 * Invite = access: a member row for your wallet address is all it takes; it is marked joined the
 * first time you act while signed in.
 */
import { and, eq, isNull } from "drizzle-orm";
import { AuthError, sessionAddress } from "../auth";
import { db, schema } from "../db";
import type { AgentRow, MemberRow, RoleRow, WorkspaceRow } from "../db/schema";
import { can, type MemberAccess, type Permission } from "../perm/permissions";
import { forbidden, notFound } from "./http";

export type Membership = { address: string; workspace: WorkspaceRow; member: MemberRow; role: RoleRow; permissions: string[] };

export function requireAddress(req: Request): string {
  const a = sessionAddress(req);
  if (!a) throw new AuthError("sign in with your wallet first");
  return a;
}

export function loadMembership(address: string, workspaceId: string): Membership | null {
  const workspace = db().select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get();
  if (!workspace) return null;
  const member = db()
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.address, address)))
    .get();
  if (!member) return null;
  const role = db().select().from(schema.roles).where(eq(schema.roles.id, member.roleId)).get();
  if (!role) return null;
  if (!member.joinedAt) {
    const now = new Date().toISOString();
    db().update(schema.members).set({ joinedAt: now }).where(and(eq(schema.members.id, member.id), isNull(schema.members.joinedAt))).run();
    member.joinedAt = now;
  }
  return { address, workspace, member, role, permissions: JSON.parse(role.permissions) as string[] };
}

/** Signed in + a member of this workspace (+ optionally holding a permission). 404 hides workspaces you are not in. */
export function requireMember(req: Request, workspaceId: string, perm?: Permission): Membership {
  const address = requireAddress(req);
  const m = loadMembership(address, workspaceId);
  if (!m) throw notFound("workspace not found");
  if (perm && !can(m.permissions, perm)) throw forbidden(`your role (${m.role.name}) can't do this: needs ${perm}`);
  return m;
}

export function requirePerm(m: Membership, perm: Permission) {
  if (!can(m.permissions, perm)) throw forbidden(`your role (${m.role.name}) can't do this: needs ${perm}`);
}

export const memberAccess = (m: Membership): MemberAccess => ({ id: m.member.id, roleId: m.member.roleId, permissions: m.permissions });

/** Load an agent and the caller's membership in its workspace. */
export function requireAgentMember(req: Request, agentId: string): { m: Membership; agent: AgentRow } {
  const agent = db().select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  if (!agent) throw notFound("agent not found");
  const m = requireMember(req, agent.workspaceId);
  return { m, agent };
}
