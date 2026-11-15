/**
 * Workspaces (one per treasury contract), members (invited by wallet address), roles and
 * saved payees. Server-only.
 */
import { and, eq, sql } from "drizzle-orm";
import { decodeEventLog, getAddress, isAddress, keccak256, type Address, type Hash } from "viem";
import { approversOf, chain, treasuryState, usdcBalance } from "../arc";
import { formatUnits } from "viem";
import { companyTreasuryAbi, treasuryFactoryAbi, TREASURY_FACTORY_ADDRESS } from "../contracts/abis";
import { db, schema } from "../db";
import { DEFAULT_ROLES, validateCustomRolePermissions, type Permission } from "../perm/permissions";
import { watchAddresses } from "../quicknode/kv";
import { badRequest, conflict, forbidden, notFound, prepare, type PreparedTx } from "./http";
import type { Membership } from "./access";
import { id } from "./util";

const lc = (a: string) => a.toLowerCase();
const now = () => new Date().toISOString();

// ───────────── onchain checks ─────────────

let treasuryCodeHash: string | null = null;
/** Was this contract deployed by our factory? (every CompanyTreasury from it has the same runtime code) */
export async function isOurTreasury(addr: Address): Promise<boolean> {
  if (!treasuryCodeHash) {
    const first = (await chain.readContract({ address: TREASURY_FACTORY_ADDRESS, abi: treasuryFactoryAbi, functionName: "treasuryAt", args: [0n] })) as Address;
    const code = await chain.getCode({ address: first });
    if (!code) return false;
    treasuryCodeHash = keccak256(code);
  }
  const code = await chain.getCode({ address: addr });
  return !!code && keccak256(code) === treasuryCodeHash;
}

export const isOnchainApprover = (treasury: string, address: string) =>
  chain.readContract({ address: treasury as Address, abi: companyTreasuryAbi, functionName: "isApprover", args: [address as Address] }) as Promise<boolean>;

// ───────────── workspaces ─────────────

/** The createTreasury call for the creator's wallet. Approvers default to the creator; agents are added later. */
export function prepareCreate(creator: string, o: { name: string; approvers?: string[]; threshold?: number }): PreparedTx {
  const approvers = (o.approvers?.length ? o.approvers : [creator]).map((a) => {
    if (!isAddress(a)) throw badRequest(`bad approver address ${a}`);
    return getAddress(a);
  });
  const threshold = o.threshold ?? 1;
  if (threshold < 1 || threshold > approvers.length) throw badRequest("threshold must be between 1 and the number of approvers");
  return prepare(TREASURY_FACTORY_ADDRESS, treasuryFactoryAbi, "createTreasury", [o.name, approvers, [], threshold], `Create the treasury for ${o.name}`);
}

/** Register a workspace for a treasury our factory created; the caller must be one of its approvers. */
export async function createWorkspace(address: string, o: { name: string; txHash?: string; treasury?: string; title?: string }) {
  let treasury = o.treasury;
  if (o.txHash) {
    const receipt = await chain.waitForTransactionReceipt({ hash: o.txHash as Hash, timeout: 60_000 });
    for (const log of receipt.logs) {
      if (lc(log.address) !== lc(TREASURY_FACTORY_ADDRESS)) continue;
      try {
        const ev = decodeEventLog({ abi: treasuryFactoryAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "TreasuryCreated") treasury = (ev.args as { treasury: string }).treasury;
      } catch {}
    }
    if (!treasury) throw badRequest("that transaction did not create a treasury with our factory");
  }
  if (!treasury || !isAddress(treasury)) throw badRequest("give the createTreasury txHash or the treasury address");
  if (!(await isOurTreasury(treasury as Address))) throw badRequest("that address is not a Cosign treasury");
  if (!(await isOnchainApprover(treasury, address))) throw forbidden("only an approver of that treasury can set up its workspace");
  if (db().select().from(schema.workspaces).where(eq(schema.workspaces.treasury, lc(treasury))).get()) throw conflict("that treasury already has a workspace");

  const ws = { id: id("ws"), name: o.name, treasury: lc(treasury), createdBy: address, createdAt: now() };
  const roleIds: Record<string, string> = {};
  db().transaction((tx) => {
    tx.insert(schema.workspaces).values(ws).run();
    for (const r of DEFAULT_ROLES) {
      const rid = id("role");
      roleIds[r.key ?? r.name] = rid;
      tx.insert(schema.roles).values({ id: rid, workspaceId: ws.id, key: r.key, name: r.name, permissions: JSON.stringify(r.permissions), system: r.system ? 1 : 0, createdAt: now() }).run();
    }
    tx.insert(schema.members).values({ id: id("mem"), workspaceId: ws.id, address, roleId: roleIds.all_access, title: o.title ?? null, invitedBy: null, createdAt: now(), joinedAt: now() }).run();
  });
  await watchAddresses({ treasuries: [treasury] }).catch(() => {});
  return ws;
}

export async function workspaceDetail(m: Membership) {
  const [st, mine] = await Promise.all([treasuryState(m.workspace.treasury as Address), usdcBalance(m.address as Address).catch(() => null)]);
  return {
    workspace: m.workspace,
    treasury: { address: m.workspace.treasury, name: st.name, balanceUsd: st.balance, threshold: st.threshold, paused: st.paused, approvers: st.approvers.map(lc) },
    me: {
      memberId: m.member.id,
      address: m.address,
      title: m.member.title,
      role: { id: m.role.id, name: m.role.name, key: m.role.key },
      permissions: m.permissions,
      onchainApprover: st.approvers.map(lc).includes(m.address),
      walletUsdc: mine === null ? null : formatUnits(mine, 6),
    },
  };
}

export function myWorkspaces(address: string) {
  return db()
    .select({ id: schema.workspaces.id, name: schema.workspaces.name, treasury: schema.workspaces.treasury, role: schema.roles.name, roleKey: schema.roles.key, title: schema.members.title })
    .from(schema.members)
    .innerJoin(schema.workspaces, eq(schema.members.workspaceId, schema.workspaces.id))
    .innerJoin(schema.roles, eq(schema.members.roleId, schema.roles.id))
    .where(eq(schema.members.address, address))
    .all();
}

// ───────────── members ─────────────

function allAccessRoleId(workspaceId: string) {
  return db().select().from(schema.roles).where(and(eq(schema.roles.workspaceId, workspaceId), eq(schema.roles.key, "all_access"))).get()!.id;
}
function roleInWorkspace(workspaceId: string, roleId: string) {
  const r = db().select().from(schema.roles).where(and(eq(schema.roles.id, roleId), eq(schema.roles.workspaceId, workspaceId))).get();
  if (!r) throw badRequest("unknown role for this workspace");
  return r;
}
function allAccessCount(workspaceId: string) {
  const rid = allAccessRoleId(workspaceId);
  return db().select({ n: sql<number>`count(*)` }).from(schema.members).where(and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.roleId, rid))).get()!.n;
}

export async function listMembers(m: Membership) {
  const approvers = (await approversOf(m.workspace.treasury as Address)).map(lc);
  const rows = db()
    .select({ member: schema.members, role: schema.roles })
    .from(schema.members)
    .innerJoin(schema.roles, eq(schema.members.roleId, schema.roles.id))
    .where(eq(schema.members.workspaceId, m.workspace.id))
    .all();
  return rows.map(({ member, role }) => {
    const perms = JSON.parse(role.permissions) as string[];
    const onchainApprover = approvers.includes(member.address);
    return {
      id: member.id,
      address: member.address,
      title: member.title,
      role: { id: role.id, name: role.name, key: role.key },
      joined: !!member.joinedAt,
      onchainApprover,
      // a cosigning role whose wallet isn't on the contract yet: an approver must propose adding it
      needsOnchainApprover: perms.includes("payments.cosign") && !onchainApprover,
    };
  });
}

export function inviteMember(m: Membership, o: { address: string; roleId: string; title?: string | null }) {
  if (!isAddress(o.address)) throw badRequest("bad wallet address");
  roleInWorkspace(m.workspace.id, o.roleId);
  const address = lc(o.address);
  if (db().select().from(schema.members).where(and(eq(schema.members.workspaceId, m.workspace.id), eq(schema.members.address, address))).get()) {
    throw conflict("that wallet is already in this workspace");
  }
  const row = { id: id("mem"), workspaceId: m.workspace.id, address, roleId: o.roleId, title: o.title ?? null, invitedBy: m.address, createdAt: now(), joinedAt: null };
  db().insert(schema.members).values(row).run();
  return row;
}

export function updateMember(m: Membership, memberId: string, o: { roleId?: string; title?: string | null }) {
  const target = db().select().from(schema.members).where(and(eq(schema.members.id, memberId), eq(schema.members.workspaceId, m.workspace.id))).get();
  if (!target) throw notFound("member not found");
  if (o.roleId) {
    roleInWorkspace(m.workspace.id, o.roleId);
    const aa = allAccessRoleId(m.workspace.id);
    if (target.roleId === aa && o.roleId !== aa && allAccessCount(m.workspace.id) <= 1) throw badRequest("a workspace needs at least one All access member");
  }
  db()
    .update(schema.members)
    .set({ ...(o.roleId ? { roleId: o.roleId } : {}), ...("title" in o ? { title: o.title ?? null } : {}) })
    .where(eq(schema.members.id, memberId))
    .run();
  return db().select().from(schema.members).where(eq(schema.members.id, memberId)).get();
}

export function removeMember(m: Membership, memberId: string) {
  const target = db().select().from(schema.members).where(and(eq(schema.members.id, memberId), eq(schema.members.workspaceId, m.workspace.id))).get();
  if (!target) throw notFound("member not found");
  if (target.roleId === allAccessRoleId(m.workspace.id) && allAccessCount(m.workspace.id) <= 1) throw badRequest("a workspace needs at least one All access member");
  db().delete(schema.members).where(eq(schema.members.id, memberId)).run();
  return { removed: memberId, note: "their private agents stay; All access can retire them" };
}

// ───────────── roles ─────────────

export function listRoles(m: Membership) {
  return db()
    .select()
    .from(schema.roles)
    .where(eq(schema.roles.workspaceId, m.workspace.id))
    .all()
    .map((r) => ({ id: r.id, name: r.name, key: r.key, system: !!r.system, permissions: JSON.parse(r.permissions) as Permission[] }));
}

export function createRole(m: Membership, o: { name: string; permissions: string[] }) {
  const perms = validateCustomRolePermissions(o.permissions);
  if (db().select().from(schema.roles).where(and(eq(schema.roles.workspaceId, m.workspace.id), eq(schema.roles.name, o.name))).get()) throw conflict("a role with that name exists");
  const row = { id: id("role"), workspaceId: m.workspace.id, key: null, name: o.name, permissions: JSON.stringify(perms), system: 0, createdAt: now() };
  db().insert(schema.roles).values(row).run();
  return { id: row.id, name: row.name, key: null, system: false, permissions: perms };
}

function customRole(m: Membership, roleId: string) {
  const r = db().select().from(schema.roles).where(and(eq(schema.roles.id, roleId), eq(schema.roles.workspaceId, m.workspace.id))).get();
  if (!r) throw notFound("role not found");
  if (r.system) throw forbidden(`${r.name} is a fixed role and can't be changed`);
  return r;
}

export function updateRole(m: Membership, roleId: string, o: { name?: string; permissions?: string[] }) {
  customRole(m, roleId);
  const set: Record<string, string> = {};
  if (o.name) set.name = o.name;
  if (o.permissions) set.permissions = JSON.stringify(validateCustomRolePermissions(o.permissions));
  db().update(schema.roles).set(set).where(eq(schema.roles.id, roleId)).run();
  return listRoles(m).find((r) => r.id === roleId);
}

export function deleteRole(m: Membership, roleId: string) {
  customRole(m, roleId);
  const used = db().select({ n: sql<number>`count(*)` }).from(schema.members).where(eq(schema.members.roleId, roleId)).get()!.n;
  if (used) throw badRequest(`${used} member(s) still have this role; move them first`);
  db().delete(schema.roles).where(eq(schema.roles.id, roleId)).run();
  return { deleted: roleId };
}

// ───────────── contacts (saved payees) ─────────────

export const listContacts = (workspaceId: string) => db().select().from(schema.contacts).where(eq(schema.contacts.workspaceId, workspaceId)).all();

export function addContact(m: Membership, o: { name: string; address: string; notes?: string | null }) {
  if (!isAddress(o.address)) throw badRequest("bad address");
  const address = lc(o.address);
  if (address === m.workspace.treasury) throw badRequest("the treasury can't be a payee");
  if (db().select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, m.workspace.id), eq(schema.contacts.address, address))).get()) {
    throw conflict("that address is already saved");
  }
  const row = { id: id("con"), workspaceId: m.workspace.id, name: o.name, address, notes: o.notes ?? null, createdBy: m.address, createdAt: now() };
  db().insert(schema.contacts).values(row).run();
  return row;
}

export function removeContact(m: Membership, contactId: string) {
  const r = db().delete(schema.contacts).where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.workspaceId, m.workspace.id))).returning().all();
  if (!r.length) throw notFound("contact not found");
  // removing a payee also takes it off every agent's allowed payees (tightening only)
  let agentsUpdated = 0;
  for (const a of db().select().from(schema.agents).where(eq(schema.agents.workspaceId, m.workspace.id)).all()) {
    const c = JSON.parse(a.controls) as { allowedPayees: string[] };
    if (!c.allowedPayees.includes(r[0].address)) continue;
    c.allowedPayees = c.allowedPayees.filter((x) => x !== r[0].address);
    db().update(schema.agents).set({ controls: JSON.stringify(c), updatedAt: now() }).where(eq(schema.agents.id, a.id)).run();
    agentsUpdated++;
  }
  return { removed: contactId, agentsUpdated };
}
