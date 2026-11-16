/**
 * Rooms against the running app (pnpm dev), with real wallet sign-ins: two people in one company see the same room.
 * One fresh throwaway company per run (not the demo company). Costs ~0.1 testnet USDC from the demo CFO (gas for
 * createTreasury); no agents, no Grok calls.
 * Run: pnpm exec tsx --env-file=.env.local --test tests/e2e/rooms.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { api, fund, person, send, signIn } from "./helpers";

const owner = person("room-owner"), emma = person("room-emma"), sam = person("room-sam"), mallory = person("room-mallory");
const s: Record<string, any> = {};
const ws = (p = "") => `/workspaces/${s.ws}${p}`;

test("a throwaway company with Emma (Agent user) and Sam (Agent user)", async () => {
  await signIn(owner);
  await fund(owner.address, "0.1");
  const prep = await api(owner, "POST", "/workspaces/prepare", { name: `Rooms E2E ${Date.now()}` });
  assert.equal(prep.status, 200, JSON.stringify(prep.json));
  const txHash = await send(owner, prep.json.tx);
  const r = await api(owner, "POST", "/workspaces", { name: "Rooms E2E", txHash, title: "Simon" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  s.ws = r.json.workspace.id;
  const roles = (await api(owner, "GET", ws("/roles"))).json.roles as { id: string; name: string }[];
  const user = roles.find((x) => x.name === "Agent user")!.id;
  for (const [p, title] of [[emma, "Emma"], [sam, "Sam"]] as const) {
    assert.equal((await api(owner, "POST", ws("/members"), { address: p.address, roleId: user, title })).status, 201);
    await signIn(p);
  }
  await signIn(mallory);
  const people = (await api(owner, "GET", ws("/team"))).json.people as { id: string; name: string; address: string }[];
  s.ids = Object.fromEntries(people.map((p) => [p.name, p.id]));
  assert.ok(s.ids.Emma && s.ids.Simon, JSON.stringify(people));
});

test("one public room, the same messages in both windows", async () => {
  const made = await api(owner, "POST", ws("/rooms"), { name: "payments", visibility: "public", guidelines: "Bills and payments.", members: [s.ids.Emma] });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  s.room = made.json.room.id;
  assert.deepEqual(made.json.room.members.sort(), [s.ids.Emma, s.ids.Simon].sort());

  const listed = await api(emma, "GET", ws("/rooms"));
  assert.ok(listed.json.rooms.some((r: any) => r.id === s.room), "Emma sees the room");
  assert.equal((await api(owner, "POST", ws(`/rooms/${s.room}/lines`), { kind: "member", body: { text: "Yesterday's bill is in here." } })).status, 200);
  assert.equal((await api(emma, "POST", ws(`/rooms/${s.room}/lines`), { kind: "member", body: { text: "@Payables read bill 124." } })).status, 200);

  const fromOwner = (await api(owner, "GET", ws(`/rooms/${s.room}/lines`))).json.lines;
  const fromEmma = (await api(emma, "GET", ws(`/rooms/${s.room}/lines`))).json.lines;
  assert.deepEqual(fromOwner.map((l: any) => [l.authorId, l.text]), [[s.ids.Simon, "Yesterday's bill is in here."], [s.ids.Emma, "@Payables read bill 124."]]);
  assert.deepEqual(fromEmma, fromOwner, "both windows read the same lines");

  assert.equal((await api(sam, "POST", ws(`/rooms/${s.room}/lines`), { kind: "member", body: { text: "hi" } })).status, 403, "join first");
  assert.equal((await api(sam, "POST", ws(`/rooms/${s.room}/members`), { ids: [s.ids.Sam] })).status, 200, "anyone can join a public room");
  assert.equal((await api(sam, "POST", ws(`/rooms/${s.room}/lines`), { kind: "member", body: { text: "hi" } })).status, 200);
  assert.equal((await api(mallory, "GET", ws(`/rooms/${s.room}/lines`))).status, 404, "outsiders can't see the workspace's rooms");
});

test("a private room stays private; only its maker (or a member manager) deletes a room", async () => {
  const priv = await api(owner, "POST", ws("/rooms"), { name: "payroll", visibility: "private" });
  assert.equal(priv.status, 200);
  assert.ok(!(await api(emma, "GET", ws("/rooms"))).json.rooms.some((r: any) => r.id === priv.json.room.id));
  assert.equal((await api(emma, "GET", ws(`/rooms/${priv.json.room.id}/lines`))).status, 404);
  assert.equal((await api(emma, "DELETE", ws(`/rooms/${s.room}`))).status, 403);
  assert.equal((await api(owner, "DELETE", ws(`/rooms/${priv.json.room.id}`))).status, 200);
  assert.equal((await api(owner, "DELETE", ws(`/rooms/${s.room}`))).status, 200);
  assert.equal((await api(emma, "GET", ws("/rooms"))).json.rooms.length, 0);
});
