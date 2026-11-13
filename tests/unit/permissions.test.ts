import "./_env";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADMIN_PERMISSIONS, ALL_PERMISSIONS, canEditAgent, canSeeAgent, canTightenAgent, canUseAgent, DEFAULT_ROLES, MEMBER_PERMISSIONS, PermError,
  validateCustomRolePermissions, type AgentAccess, type MemberAccess,
} from "../../src/lib/perm/permissions";

const role = (key: string) => DEFAULT_ROLES.find((r) => (r.key ?? r.name) === key)!;
const member = (id: string, roleName: string, roleId = roleName): MemberAccess => ({ id, roleId, permissions: role(roleName).permissions });

test("two fixed major roles: All access has everything, Approver cosigns but can't run the workspace", () => {
  assert.deepEqual([...role("all_access").permissions].sort(), [...ALL_PERMISSIONS].sort());
  const ap = role("approver").permissions;
  assert.ok(ap.includes("payments.cosign") && ap.includes("agents.freeze") && ap.includes("agents.sweep"));
  for (const p of ADMIN_PERMISSIONS) assert.ok(!ap.includes(p), `approver must not have ${p}`);
  for (const p of MEMBER_PERMISSIONS) assert.ok(ap.includes(p), `approver keeps member-level ${p}`);
  assert.ok(role("all_access").system && role("approver").system);
});

test("member-level presets: Builder builds, Agent user asks for payments, Viewer only talks and sees", () => {
  assert.ok(role("Builder").permissions.includes("agents.build"));
  assert.ok(role("Agent user").permissions.includes("payments.request") && !role("Agent user").permissions.includes("agents.build"));
  assert.deepEqual([...role("Viewer").permissions].sort(), ["agents.use_team", "treasury.view"]);
  assert.ok(!role("Builder").system);
});

test("custom roles accept only member-level permissions", () => {
  assert.deepEqual(validateCustomRolePermissions(["treasury.view", "agents.use_team", "treasury.view"]), ["treasury.view", "agents.use_team"]);
  assert.throws(() => validateCustomRolePermissions(["treasury.view", "payments.cosign"]), PermError);
  assert.throws(() => validateCustomRolePermissions(["members.manage"]), PermError);
  assert.throws(() => validateCustomRolePermissions("treasury.view"), PermError);
});

test("private agents: only the creator uses them; All access can see and manage but not talk", () => {
  const agent: AgentAccess = { status: "active", visibility: "private", ownerMemberId: "carol", allowedRoleIds: null };
  const carol = member("carol", "Builder");
  const owner = member("owner", "all_access");
  const bob = member("bob", "Viewer");
  assert.equal(canUseAgent(agent, carol), true);
  assert.equal(canUseAgent(agent, owner), false);
  assert.equal(canSeeAgent(agent, owner), true);
  assert.equal(canSeeAgent(agent, bob), false);
  assert.equal(canEditAgent(agent, carol), true);
  assert.equal(canEditAgent(agent, bob), false);
});

test("team agents: anyone with agents.use_team, optionally only chosen roles; retired agents can't be used", () => {
  const team: AgentAccess = { status: "active", visibility: "team", ownerMemberId: "owner", allowedRoleIds: null };
  assert.equal(canUseAgent(team, member("bob", "Viewer")), true);
  assert.equal(canUseAgent(team, { id: "x", roleId: "r", permissions: ["treasury.view"] }), false);
  const limited = { ...team, allowedRoleIds: ["role_builder"] };
  assert.equal(canUseAgent(limited, member("bob", "Viewer", "role_viewer")), false);
  assert.equal(canUseAgent(limited, member("carol", "Builder", "role_builder")), true);
  assert.equal(canUseAgent(limited, member("owner", "all_access", "role_aa")), true, "agents.manage overrides the role list");
  assert.equal(canUseAgent({ ...team, status: "retired" }, member("owner", "all_access")), false);
});

test("who may tighten: creator, Approver (agents.freeze), All access; not a Viewer", () => {
  const team: AgentAccess = { status: "active", visibility: "team", ownerMemberId: "owner", allowedRoleIds: null };
  assert.equal(canTightenAgent(team, member("dave", "approver")), true);
  assert.equal(canTightenAgent(team, member("bob", "Viewer")), false);
  assert.equal(canTightenAgent(team, member("owner", "Viewer")), true, "the creator can always tighten");
});
