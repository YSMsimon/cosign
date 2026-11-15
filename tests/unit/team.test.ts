import "./_env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { db, schema } from "../../src/lib/db";
import type { TaskRow } from "../../src/lib/db/schema";
import { callback } from "../../src/lib/server/grokbot";
import { listTeam, MAX_ASKS_PER_PAIR, MAX_CHAIN_HOPS, mention, type MentionResult } from "../../src/lib/server/team";
import { listTeamMessages } from "../../src/lib/server/team-feed";
import { encryptSecret, sha256 } from "../../src/lib/server/util";

// A small workspace: Simon (All access), Priya (member), a viewer; team agents Clerk, Scribe, Auditor and
// Grok Bot (a connected Grok Bot routine), a private agent of Priya's and an agent only Simon's role may use.
const now = new Date().toISOString();
const WS = "ws_team";
db().insert(schema.workspaces).values({ id: WS, name: "Nova Labs", treasury: "0x00000000000000000000000000000000000000aa", createdBy: "0x1", createdAt: now }).run();
db().insert(schema.roles).values([
  { id: "role_all", workspaceId: WS, key: "all_access", name: "All access", permissions: JSON.stringify(["agents.use_team", "agents.manage"]), system: 1, createdAt: now },
  { id: "role_member", workspaceId: WS, key: null, name: "Member", permissions: JSON.stringify(["agents.use_team"]), system: 0, createdAt: now },
  { id: "role_viewer", workspaceId: WS, key: null, name: "Viewer", permissions: JSON.stringify([]), system: 0, createdAt: now },
]).run();
const member = (id: string, roleId: string, title: string, n: number) => ({ id, workspaceId: WS, address: `0x${String(n).padStart(40, "0")}`, roleId, title, invitedBy: null, createdAt: now, joinedAt: now });
db().insert(schema.members).values([member("mem_simon", "role_all", "Simon", 1), member("mem_priya", "role_member", "Priya", 2), member("mem_viewer", "role_viewer", "Viewer", 3)]).run();
const agent = (id: string, name: string, o: { visibility?: string; owner?: string; roles?: string[] } = {}) => ({
  id, workspaceId: WS, name, prompt: `${name} does its job`, visibility: o.visibility ?? "team", allowedRoleIds: o.roles ? JSON.stringify(o.roles) : null,
  ownerMemberId: o.owner ?? "mem_simon", abilities: "{}", controls: "{}", ref: `ref_${id}`, walletId: `w_${id}`, walletAddress: `0x${id.padEnd(40, "0").slice(0, 40)}`,
  status: "active", createdAt: now, updatedAt: now,
});
db().insert(schema.agents).values([
  agent("ag_clerk", "Clerk"), agent("ag_scribe", "Scribe"), agent("ag_auditor", "Auditor"), agent("ag_grok", "Grok Bot"),
  agent("ag_secret", "Secret", { visibility: "private", owner: "mem_priya" }), agent("ag_payroll", "Payroll", { roles: ["role_all"] }),
]).run();
// Grok Bot's routine points at a closed local port: starting a task for it fails at once (and must say so)
db().insert(schema.grokbotConnections).values({ id: "gbc_1", agentId: "ag_grok", webhookUrl: "http://127.0.0.1:9/hook", webhookKeyEnc: encryptSecret("key-12345678"), status: "connected", lastError: null, connectedAt: now, createdBy: "mem_simon", createdAt: now }).run();

const ok = (r: MentionResult) => {
  assert.ok(!("refused" in r), `expected a mention, got: ${"refused" in r ? r.reason : ""}`);
  return r as Exclude<MentionResult, { refused: true }>;
};
const refused = (r: MentionResult) => {
  assert.ok("refused" in r, "expected a refusal");
  return (r as { reason: string }).reason;
};
/** One mention, as a run of `from` would make it (fromTaskId = the task that run belongs to). */
const say = async (from: string, who: string, fromTaskId: string | null = null, memberId = "mem_simon") =>
  (await mention({ workspaceId: WS, fromAgentId: from, memberId, fromTaskId, who, message: `from ${from} to ${who}` })).result;

test("1. list_team: people, and only the agents this person may use; background agents marked", () => {
  const priya = listTeam({ workspaceId: WS, memberId: "mem_priya", selfAgentId: "ag_clerk" });
  assert.deepEqual(priya.people.map((p) => p.name).sort(), ["Priya", "Simon", "Viewer"]);
  const names = priya.agents.map((a) => a.name);
  assert.ok(names.includes("Secret"), "Priya's own private agent");
  assert.ok(!names.includes("Payroll"), "an agent only another role may use");
  assert.equal(priya.agents.find((a) => a.name === "Clerk")?.you, true);
  assert.equal(priya.agents.find((a) => a.name === "Grok Bot")?.runs, "background (Grok Bot)");
  assert.equal(priya.agents.find((a) => a.name === "Scribe")?.runs, "live");
  const simon = listTeam({ workspaceId: WS, memberId: "mem_simon" }).agents.map((a) => a.name);
  assert.ok(simon.includes("Payroll") && !simon.includes("Secret"));
});

test("2. mentioning a person posts to the team feed and starts nothing", async () => {
  const r = ok(await say("ag_clerk", "Priya"));
  assert.equal(r.posted.to.kind, "person");
  assert.equal(r.task, undefined);
  const row = db().select().from(schema.teamMessages).where(eq(schema.teamMessages.id, r.posted.id)).get()!;
  assert.equal(row.toKind, "member");
  assert.equal(row.toId, "mem_priya");
  assert.equal(row.taskId, null);
});

test("3. unknown names, @-prefixes, yourself, and agents the person may not use", async () => {
  assert.match(refused(await say("ag_clerk", "Nobody")), /no teammate called "Nobody"/);
  assert.match(refused(await say("ag_clerk", "Clerk")), /can't mention yourself/);
  assert.match(refused(await say("ag_clerk", "Payroll", null, "mem_priya")), /can't use Payroll/);
  assert.match(refused(await say("ag_clerk", "Secret")), /can't use Secret/, "someone else's private agent");
  ok(await say("ag_clerk", "@priya")); // case and a leading @ don't matter
});

test("4. mentioning an agent starts its task under the same person, on our loop when no Grok Bot is connected", async () => {
  const { result, runLater } = await mention({ workspaceId: WS, fromAgentId: "ag_clerk", memberId: "mem_priya", who: "Scribe", message: "Book #6 to invoice 122" });
  const r = ok(result);
  assert.equal(r.task?.engine, "cosign");
  assert.equal(typeof runLater, "function", "the caller starts our own loop");
  const task = db().select().from(schema.tasks).where(eq(schema.tasks.id, r.task!.id)).get()!;
  assert.equal(task.source, "agent");
  assert.equal(task.requestedBy, "mem_priya", "the woken agent works for the same person");
  assert.match(task.instructions, /Clerk mentioned you in Nova Labs/);
  assert.match(task.instructions, /Book #6 to invoice 122/);
  const row = db().select().from(schema.teamMessages).where(eq(schema.teamMessages.id, r.posted.id)).get()!;
  assert.equal(row.taskId, task.id);
  assert.equal(row.depth, 1);
});

test("5. a Grok Bot that can't be reached is never silent", async () => {
  const r = ok(await say("ag_clerk", "Grok Bot"));
  assert.equal(r.task?.engine, "grokbot");
  assert.equal(r.task?.status, "failed");
  const feed = listTeamMessages(WS, 5);
  assert.ok(feed.some((m) => m.fromKind === "cosign" && /Couldn't start Grok Bot: webhook unreachable/.test(m.text)));
});

test(`6. the same agent can be asked ${MAX_ASKS_PER_PAIR} times in a chain (the first ask and 2 retries)`, async () => {
  // Grok Bot asks Clerk to draft, Clerk asks for a check, Grok Bot asks for a fix, Clerk asks for a recheck, …
  const first = ok(await say("ag_scribe", "Clerk")); // a fresh chain (a person started Scribe's run)
  let fromTask = first.task!.id;
  let asks = 1;
  let speaker = "ag_clerk";
  let other = "ag_scribe";
  for (;;) {
    const r = await say(speaker, other === "ag_scribe" ? "Scribe" : "Clerk", fromTask);
    if ("refused" in r) {
      assert.match(r.reason, /already asked Clerk 3 times/);
      break;
    }
    fromTask = r.task!.id;
    if (other === "ag_clerk") asks++;
    [speaker, other] = [other, speaker];
  }
  assert.equal(asks, MAX_ASKS_PER_PAIR);
  // the refused agent can still ask a person
  assert.equal(ok(await say("ag_scribe", "Simon", fromTask)).posted.to.kind, "person");
});

test(`7. a chain stops after ${MAX_CHAIN_HOPS} agent hand-offs without a person`, async () => {
  const ring = ["Clerk", "Scribe", "Auditor"];
  const ids: Record<string, string> = { Clerk: "ag_clerk", Scribe: "ag_scribe", Auditor: "ag_auditor" };
  let from = "ag_auditor";
  let fromTask: string | null = null;
  let hops = 0;
  for (let i = 0; i < 20; i++) {
    const to = ring[i % 3];
    const r = await say(from, to, fromTask);
    if ("refused" in r) {
      assert.match(r.reason, /handed between agents 6 times without a person/);
      break;
    }
    hops++;
    fromTask = r.task!.id;
    from = ids[to];
  }
  assert.equal(hops, MAX_CHAIN_HOPS);
});

test("8. when a mentioned agent finishes, its answer is posted back to the team in the same chain", async () => {
  const r = ok(await say("ag_clerk", "Scribe"));
  const t = db().select().from(schema.tasks).where(eq(schema.tasks.id, r.task!.id)).get()!;
  // pretend it ran on Grok Bot: give it a live token and let the routine report back
  db().update(schema.tasks).set({ engine: "grokbot", status: "working", tokenHash: sha256("tok"), tokenExpiresAt: new Date(Date.now() + 60_000).toISOString() }).where(eq(schema.tasks.id, t.id)).run();
  callback({ ...t, status: "working" } as TaskRow, "result", { result: "Booked #6 to invoice 122" });
  const asked = db().select().from(schema.teamMessages).where(eq(schema.teamMessages.id, r.posted.id)).get()!;
  const reply = listTeamMessages(WS, 50).find((m) => m.fromTaskId === t.id && m.fromKind === "agent")!;
  assert.equal(reply.fromId, "ag_scribe");
  assert.equal(reply.text, "Booked #6 to invoice 122");
  assert.equal(reply.rootId, asked.rootId);
  // a failure is posted too, never silence
  const r2 = ok(await say("ag_clerk", "Scribe"));
  const t2 = db().select().from(schema.tasks).where(eq(schema.tasks.id, r2.task!.id)).get()!;
  callback({ ...t2, status: "working" } as TaskRow, "result", { error: "invoice 122 not found" });
  assert.ok(listTeamMessages(WS, 50).some((m) => m.fromTaskId === t2.id && m.text === "Couldn't finish: invoice 122 not found"));
});
