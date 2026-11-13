/**
 * Workspace roles and permissions (pure: no database, no network).
 *
 * Two major roles that every workspace has and nobody can edit or delete:
 *   All access  every permission (cosigning still needs the wallet to be an approver on the contract)
 *   Approver    cosign payments, freeze and sweep agents, plus every member-level permission
 * Member-level roles are built from member-level toggles. Three editable presets are created with
 * each workspace (Builder, Agent user, Viewer); All access can create more.
 * A title (CEO, CFO, ...) is free text on the member and never grants anything.
 */

export const ADMIN_PERMISSIONS = [
  "workspace.manage", // rename, settings
  "members.manage", // invite by wallet address, change roles, remove
  "roles.manage", // create / edit / delete custom roles
  "agents.manage", // create team agents, edit any agent
  "agents.money", // turn on money abilities, loosen limits, payees, sellers, unfreeze
  "grokbot.manage", // connect Grok Bot to any agent
] as const;

export const APPROVER_PERMISSIONS = [
  "payments.cosign", // cosign payments and approver changes (wallet must be an approver onchain)
  "agents.freeze", // freeze an agent or tighten its limits
  "agents.sweep", // move an agent's wallet balance back to the treasury
] as const;

export const MEMBER_PERMISSIONS = [
  "treasury.view", // see the treasury, proposals and activity
  "agents.use_team", // talk to team agents
  "agents.build", // build private agents
  "payments.request", // ask an agent to buy, draft or draw petty cash; OK an agent's purchase above its ask-above line
  "contacts.manage", // add and remove saved payees
  "schedules.create", // schedule jobs for agents you can use
] as const;

export type Permission = (typeof ADMIN_PERMISSIONS)[number] | (typeof APPROVER_PERMISSIONS)[number] | (typeof MEMBER_PERMISSIONS)[number];
export const ALL_PERMISSIONS: Permission[] = [...ADMIN_PERMISSIONS, ...APPROVER_PERMISSIONS, ...MEMBER_PERMISSIONS];
export const MEMBER_LEVEL = new Set<string>(MEMBER_PERMISSIONS);

export type SystemRoleKey = "all_access" | "approver";
export type RoleSeed = { key: SystemRoleKey | null; name: string; permissions: Permission[]; system: boolean };

export const DEFAULT_ROLES: RoleSeed[] = [
  { key: "all_access", name: "All access", permissions: ALL_PERMISSIONS, system: true },
  { key: "approver", name: "Approver", permissions: [...APPROVER_PERMISSIONS, ...MEMBER_PERMISSIONS], system: true },
  { key: null, name: "Builder", permissions: ["treasury.view", "agents.use_team", "agents.build", "payments.request", "contacts.manage", "schedules.create"], system: false },
  { key: null, name: "Agent user", permissions: ["treasury.view", "agents.use_team", "payments.request"], system: false },
  { key: null, name: "Viewer", permissions: ["treasury.view", "agents.use_team"], system: false },
];

export function can(permissions: readonly string[] | undefined | null, p: Permission): boolean {
  return !!permissions?.includes(p);
}

/** Custom roles may only hold member-level permissions (the two major roles are fixed). */
export function validateCustomRolePermissions(perms: unknown): Permission[] {
  if (!Array.isArray(perms)) throw new PermError("permissions must be a list");
  const out = [...new Set(perms.map(String))];
  const bad = out.filter((p) => !MEMBER_LEVEL.has(p));
  if (bad.length) throw new PermError(`custom roles can only use member-level permissions; not allowed: ${bad.join(", ")}`);
  return out as Permission[];
}

export class PermError extends Error {}

// ───────────── agent access ─────────────

export type AgentAccess = {
  status: string; // active | retired
  visibility: "private" | "team";
  ownerMemberId: string;
  allowedRoleIds: string[] | null; // team agents: null = every member with agents.use_team
};
export type MemberAccess = { id: string; roleId: string; permissions: readonly string[] };

/** May this member talk to / run this agent? Private: only its creator. Team: members with agents.use_team (and an allowed role). */
export function canUseAgent(agent: AgentAccess, m: MemberAccess): boolean {
  if (agent.status !== "active") return false;
  if (agent.visibility === "private") return agent.ownerMemberId === m.id;
  if (!can(m.permissions, "agents.use_team")) return false;
  return !agent.allowedRoleIds || agent.allowedRoleIds.includes(m.roleId) || can(m.permissions, "agents.manage");
}

/** May this member see the agent and its wallet (not necessarily talk to it)? */
export function canSeeAgent(agent: AgentAccess, m: MemberAccess): boolean {
  return canUseAgent(agent, m) || agent.ownerMemberId === m.id || can(m.permissions, "agents.manage") || can(m.permissions, "payments.cosign");
}

/** May this member edit the agent's name, prompt and visibility? Its creator or anyone with agents.manage. */
export function canEditAgent(agent: AgentAccess, m: MemberAccess): boolean {
  return agent.ownerMemberId === m.id || can(m.permissions, "agents.manage");
}

/** May this member tighten limits or freeze? Creator, agents.freeze, or All access. */
export function canTightenAgent(agent: AgentAccess, m: MemberAccess): boolean {
  return agent.ownerMemberId === m.id || can(m.permissions, "agents.freeze") || can(m.permissions, "agents.money");
}
