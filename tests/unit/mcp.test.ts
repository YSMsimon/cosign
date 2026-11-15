import "./_env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONTROLS } from "../../src/lib/agent/rules";
import { db, schema } from "../../src/lib/db";
import { loadMembership } from "../../src/lib/server/access";
import { handleMcp, issueMcpToken, MCP_PROTOCOL, revokeMcpTokens } from "../../src/lib/server/mcp";
import { listTeamMessages } from "../../src/lib/server/team-feed";
import { sha256 } from "../../src/lib/server/util";

// One workspace, two members, Clerk (the agent a Grok Bot routine works as) and Scribe.
const now = new Date().toISOString();
const WS = "ws_mcp";
const SIMON = "0x00000000000000000000000000000000000000a1";
db().insert(schema.workspaces).values({ id: WS, name: "Nova Labs", treasury: "0x00000000000000000000000000000000000000bb", createdBy: SIMON, createdAt: now }).run();
db().insert(schema.roles).values([
  { id: "mr_all", workspaceId: WS, key: "all_access", name: "All access", permissions: JSON.stringify(["agents.use_team", "agents.manage", "grokbot.manage"]), system: 1, createdAt: now },
  { id: "mr_member", workspaceId: WS, key: null, name: "Member", permissions: JSON.stringify(["agents.use_team"]), system: 0, createdAt: now },
]).run();
db().insert(schema.members).values([
  { id: "mm_simon", workspaceId: WS, address: SIMON, roleId: "mr_all", title: "Simon", invitedBy: null, createdAt: now, joinedAt: now },
  { id: "mm_priya", workspaceId: WS, address: "0x00000000000000000000000000000000000000a2", roleId: "mr_member", title: "Priya", invitedBy: null, createdAt: now, joinedAt: now },
]).run();
const agent = (id: string, name: string) => ({
  id, workspaceId: WS, name, prompt: `${name} does its job`, visibility: "team", allowedRoleIds: null, ownerMemberId: "mm_simon",
  abilities: JSON.stringify({ buy: false, draft: false, pettyCash: false, sandbox: false }), controls: JSON.stringify(DEFAULT_CONTROLS), ref: `mref-${id.replace("ma_", "")}`, walletId: `w_${id}`,
  walletAddress: `0x${id.padEnd(40, "0").slice(0, 40)}`, status: "active", createdAt: now, updatedAt: now,
});
db().insert(schema.agents).values([agent("ma_clerk", "Clerk"), agent("ma_scribe", "Scribe")]).run();
const m = loadMembership(SIMON, WS)!;
const clerk = db().select().from(schema.agents).all().find((a) => a.id === "ma_clerk")!;

const call = async (token: string | null, body: unknown) => {
  const res = await handleMcp(new Request("http://localhost/api/v1/mcp", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));
  return { status: res.status, headers: res.headers, body: res.status === 202 ? null : ((await res.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string } }) };
};
const rpc = (method: string, params: Record<string, unknown> = {}, id = 1) => ({ jsonrpc: "2.0", id, method, params });
const text = (r: { body: { result?: Record<string, unknown> } | null }) => JSON.parse(((r.body?.result?.content as { text: string }[]) ?? [{ text: "null" }])[0].text);

test("1. no token or a wrong token: 401 with a Bearer challenge", async () => {
  const none = await call(null, rpc("ping"));
  assert.equal(none.status, 401);
  assert.match(none.headers.get("www-authenticate") ?? "", /^Bearer/);
  assert.equal((await call("cmcp_wrong", rpc("ping"))).status, 401);
});

test("2. initialize, the initialized notification, ping", async () => {
  const { token } = issueMcpToken(m, clerk);
  const init = await call(token, rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
  assert.equal(init.status, 200);
  assert.equal(init.body?.result?.protocolVersion, "2025-06-18");
  assert.deepEqual(init.body?.result?.capabilities, { tools: { listChanged: false } });
  assert.match(String((init.body?.result?.serverInfo as { title: string }).title), /Clerk, Nova Labs/);
  const odd = await call(token, rpc("initialize", { protocolVersion: "1999-01-01" }));
  assert.equal(odd.body?.result?.protocolVersion, MCP_PROTOCOL, "an unknown version gets ours");
  assert.equal((await call(token, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  assert.deepEqual((await call(token, rpc("ping"))).body?.result, {});
});

test("3. tools/list: the Grok Bot tool set (no microVM tools); every tool takes task_id", async () => {
  const { token } = issueMcpToken(m, clerk);
  const r = await call(token, rpc("tools/list"));
  const tools = r.body?.result?.tools as { name: string; inputSchema: { properties: Record<string, unknown> } }[];
  const names = tools.map((t) => t.name);
  for (const n of ["list_team", "mention", "get_balances", "list_proposals", "memory_read"]) assert.ok(names.includes(n), n);
  for (const n of ["sandbox_bash", "read_file", "write_file"]) assert.ok(!names.includes(n), `${n} must not be offered`);
  assert.ok(!names.includes("propose_payment"), "abilities still decide: this Clerk can't draft");
  assert.ok(tools.every((t) => "task_id" in t.inputSchema.properties));
});

test("4. tools/call: results as text content; refusals are isError, unknown tools and methods are JSON-RPC errors", async () => {
  const { token } = issueMcpToken(m, clerk);
  const team = await call(token, rpc("tools/call", { name: "list_team", arguments: {} }));
  assert.equal(team.body?.result?.isError, false);
  assert.deepEqual(text(team).agents.map((a: { name: string }) => a.name).sort(), ["Clerk", "Scribe"]);
  const vm = await call(token, rpc("tools/call", { name: "sandbox_bash", arguments: { command: "id" } }));
  assert.equal(vm.body?.result?.isError, true);
  assert.match(text(vm).reason, /not available here/);
  assert.equal((await call(token, rpc("tools/call", { name: "nope", arguments: {} }))).body?.error?.code, -32602);
  assert.equal((await call(token, rpc("resources/list"))).body?.error?.code, -32601);
  const batch = await call(token, [rpc("ping", {}, 1), { jsonrpc: "2.0", method: "notifications/initialized" }, rpc("ping", {}, 2)]);
  assert.equal((batch.body as unknown as unknown[]).length, 2, "a batch answers each request, not the notification");
});

test("5. inside a Grok Bot job, calls act for the person who asked and join the job's chain", async () => {
  const { token } = issueMcpToken(m, clerk);
  const taskId = "task_mcp_job";
  db().insert(schema.tasks).values({
    id: taskId, workspaceId: WS, agentId: "ma_clerk", kind: "task", source: "member", engine: "grokbot", instructions: "check the drafts",
    status: "acked", tokenHash: sha256("job-token"), tokenExpiresAt: new Date(Date.now() + 600_000).toISOString(), requestedBy: "mm_priya",
    scheduleId: null, progress: "[]", result: null, error: null, createdAt: now, updatedAt: now,
  }).run();
  const r = await call(token, rpc("tools/call", { name: "mention", arguments: { who: "Simon", message: "#8 doesn't match its invoice", task_id: taskId } }));
  assert.equal(r.body?.result?.isError, false, JSON.stringify(r.body));
  const row = listTeamMessages(WS, 10).find((x) => x.text === "#8 doesn't match its invoice")!;
  assert.equal(row.fromTaskId, taskId);
  assert.equal(row.toId, "mm_simon");
});

test("6. a new token revokes the old one; revoking ends access", async () => {
  const a = issueMcpToken(m, clerk).token;
  const b = issueMcpToken(m, clerk).token;
  assert.equal((await call(a, rpc("ping"))).status, 401);
  assert.equal((await call(b, rpc("ping"))).status, 200);
  revokeMcpTokens(m, clerk);
  assert.equal((await call(b, rpc("ping"))).status, 401);
});
