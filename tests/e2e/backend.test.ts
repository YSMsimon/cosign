/**
 * Full backend test against the running app (pnpm dev) on Arc testnet with real wallets.
 * Steps run in order and share state: one fresh company per run.
 * People: owner (All access, onchain approver), bob (Viewer), carol (Builder), dave (Approver), mallory (outsider).
 * Costs per run: ~0.6 testnet USDC from the demo CFO, two Circle wallets, ~3 short Grok turns (a few cents).
 * Run: pnpm test:e2e
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { APP, api, fund, person, send, signIn, siweFor, sse, startMockBot, waitFor, type PreparedTx } from "./helpers";

const owner = person("owner"), bob = person("bob"), carol = person("carol"), dave = person("dave"), mallory = person("mallory");
const LENA = (process.env.DEPLOYER_ADDRESS as string).toLowerCase();
const VENDOR_CHECK = `${APP}/api/sellers/vendor-check?address=${LENA}`; // $0.02 demo paid API
const s: Record<string, any> = {};
const bot = startMockBot(4555, "mock-webhook-key-123456");
after(() => bot.close());

const ws = (p = "") => `/workspaces/${s.ws}${p}`;
const plan = (calls: { name: string; args?: Record<string, unknown> }[]) => JSON.stringify({ calls: calls.map((c) => ({ args: {}, ...c })) });
const taskDone = (id: string, p = owner) => waitFor(`task ${id}`, async () => {
  const r = await api(p, "GET", `/tasks/${id}`);
  return ["done", "failed"].includes(r.json?.task?.status) ? r.json.task : null;
}, 120_000);
const botResults = (taskId: string) => waitFor(`mock bot results for ${taskId}`, async () => bot.seen.find((x) => x.body.task_id === taskId && x.results)?.results, 60_000, 300);

test("server is up; unknown routes 404; signed-out calls 401", async () => {
  assert.equal((await api(null, "GET", "/auth/nonce")).status, 200);
  assert.equal((await api(null, "GET", "/nope")).status, 404);
  assert.equal((await api(null, "GET", "/me")).status, 401);
});

test("wallet sign-in; a nonce can't be replayed; another site's message is refused; logout works", async () => {
  await signIn(owner);
  const me = await api(owner, "GET", "/me");
  assert.equal(me.json.address, owner.address);
  const once = await siweFor(owner);
  assert.equal((await api(null, "POST", "/auth/verify", once)).status, 200);
  assert.equal((await api(null, "POST", "/auth/verify", once)).status, 401, "replay");
  assert.equal((await api(null, "POST", "/auth/verify", await siweFor(owner, { domain: "evil.example" }))).status, 401);
  const temp = { ...owner, cookie: undefined as string | undefined };
  await signIn(temp);
  assert.equal((await api(temp, "POST", "/auth/logout")).status, 200);
  assert.equal((await api(temp, "GET", "/me")).status, 401);
});

test("fund the owner's wallet with testnet USDC (from the demo CFO)", async () => {
  await fund(owner.address, "0.6");
});

test("create a company: prepare → owner's wallet sends createTreasury → register the workspace", async () => {
  const prep = await api(owner, "POST", "/workspaces/prepare", { name: `E2E Co ${Date.now()}` });
  assert.equal(prep.status, 200);
  const txHash = await send(owner, prep.json.tx);
  const r = await api(owner, "POST", "/workspaces", { name: "E2E Co", txHash, title: "CEO" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  s.ws = r.json.workspace.id;
  s.treasury = r.json.workspace.treasury;
  const d = await api(owner, "GET", ws());
  assert.equal(d.json.me.role.key, "all_access");
  assert.equal(d.json.me.onchainApprover, true);
  assert.equal(d.json.treasury.threshold, 1);
  assert.equal((await api(owner, "POST", "/workspaces", { name: "again", treasury: s.treasury })).status, 409);
  await signIn(mallory);
  assert.equal((await api(mallory, "POST", "/workspaces", { name: "steal", treasury: s.treasury })).status, 403, "not an approver of that treasury");
  assert.equal((await api(mallory, "GET", ws())).status, 404, "outsiders can't see the workspace");
});

test("roles: two fixed major roles + three member-level presets; custom roles are member-level only", async () => {
  const r = await api(owner, "GET", ws("/roles"));
  const byName = Object.fromEntries(r.json.roles.map((x: any) => [x.name, x]));
  assert.deepEqual(Object.keys(byName).sort(), ["Agent user", "All access", "Approver", "Builder", "Viewer"]);
  s.roles = Object.fromEntries(r.json.roles.map((x: any) => [x.name, x.id]));
  const payroll = await api(owner, "POST", ws("/roles"), { name: "Payroll", permissions: ["treasury.view", "payments.request", "contacts.manage"] });
  assert.equal(payroll.status, 201);
  assert.equal((await api(owner, "POST", ws("/roles"), { name: "Sneaky", permissions: ["payments.cosign"] })).status, 403);
  assert.equal((await api(owner, "PATCH", ws(`/roles/${s.roles.Approver}`), { name: "Boss" })).status, 403, "fixed roles are locked");
  assert.equal((await api(owner, "DELETE", ws(`/roles/${payroll.json.role.id}`))).status, 200);
});

test("members: invite by wallet address; access starts when that wallet signs in", async () => {
  for (const [p, role, title] of [[bob, "Viewer", "Auditor"], [carol, "Builder", "Ops"], [dave, "Approver", "CFO"]] as const) {
    const r = await api(owner, "POST", ws("/members"), { address: p.address, roleId: s.roles[role], title });
    assert.equal(r.status, 201, JSON.stringify(r.json));
  }
  await signIn(bob);
  await signIn(carol);
  await signIn(dave);
  const me = await api(bob, "GET", "/me");
  assert.ok(me.json.workspaces.some((w: any) => w.id === s.ws && w.role === "Viewer" && w.title === "Auditor"));
  assert.equal((await api(bob, "POST", ws("/members"), { address: mallory.address, roleId: s.roles.Viewer })).status, 403);
  assert.equal((await api(owner, "POST", ws("/members"), { address: bob.address, roleId: s.roles.Viewer })).status, 409);
  const ms = await api(owner, "GET", ws("/members"));
  const ownerRow = ms.json.find((m: any) => m.address === owner.address);
  s.ownerMember = ownerRow.id;
  assert.equal((await api(owner, "PATCH", ws(`/members/${ownerRow.id}`), { roleId: s.roles.Viewer })).status, 400, "last All access can't step down");
  assert.equal((await api(owner, "DELETE", ws(`/members/${ownerRow.id}`))).status, 400);
  const daveRow = ms.json.find((m: any) => m.address === dave.address);
  assert.equal(daveRow.needsOnchainApprover, true, "Approver role, wallet not on the contract yet");
});

test("contacts: Builders save payees, Viewers can't, no duplicates", async () => {
  assert.equal((await api(owner, "POST", ws("/contacts"), { name: "Lena (contractor)", address: LENA })).status, 201);
  assert.equal((await api(bob, "POST", ws("/contacts"), { name: "x", address: mallory.address })).status, 403);
  assert.equal((await api(carol, "POST", ws("/contacts"), { name: "Print shop", address: "0x00000000000000000000000000000000000000aa" })).status, 201);
  assert.equal((await api(carol, "POST", ws("/contacts"), { name: "dup", address: LENA })).status, 409);
});

test("agents: Builders make private read-only agents; only All access makes team agents or gives money abilities", async () => {
  assert.equal((await api(bob, "POST", ws("/agents"), { name: "B", prompt: "x", visibility: "private" })).status, 403);
  const c = await api(carol, "POST", ws("/agents"), { name: "Carol helper", prompt: "You help Carol with notes.", visibility: "private" });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  s.carolAgent = c.json.agent.id;
  assert.deepEqual(c.json.agent.abilities, { sandbox: true, buy: false, draft: false, pettyCash: false });
  assert.match(c.json.agent.wallet, /^0x[0-9a-f]{40}$/, "every agent gets its own wallet");
  assert.equal((await api(carol, "POST", ws("/agents"), { name: "X", prompt: "x", visibility: "private", preset: "clerk" })).status, 403);
  assert.equal((await api(carol, "POST", ws("/agents"), { name: "X", prompt: "x", visibility: "team" })).status, 403);
  assert.equal((await api(owner, "POST", ws("/agents"), { name: "Bad", prompt: "x", visibility: "team", controls: { purchases: { perPayment: 5, daily: 1 } } })).status, 400);
  const k = await api(owner, "POST", ws("/agents"), {
    name: "Clerk",
    prompt: "You handle payables: draft payments to saved payees for a human to cosign. Be brief.",
    visibility: "team",
    preset: "clerk",
    controls: {
      allowedSellers: [`${new URL(APP).host}/api/sellers`],
      allowedPayees: [LENA],
      purchases: { perPayment: 0.05, daily: 0.2, weekly: 0.5, monthly: 1 },
      drafts: { perPayment: 0.5, daily: 2, weekly: 5, monthly: 10 },
      maxPaymentsPerHour: 20,
      askAboveUsd: 0.015,
      topUpMaxUsd: 0.1,
      pettyCashPerWeekUsd: 0.2,
    },
  });
  assert.equal(k.status, 201, JSON.stringify(k.json));
  s.clerk = k.json.agent.id;
  const bobList = (await api(bob, "GET", ws("/agents"))).json.agents.map((a: any) => a.id);
  assert.ok(bobList.includes(s.clerk) && !bobList.includes(s.carolAgent), "Bob sees the team agent, not Carol's private one");
  const ownerView = (await api(owner, "GET", ws("/agents"))).json.agents.find((a: any) => a.id === s.carolAgent);
  assert.equal(ownerView.you.canUse, false, "All access can see a private agent but not talk to it");
  assert.equal((await api(bob, "GET", `/agents/${s.carolAgent}`)).status, 403);
});

test("controls: loosening needs All access; the creator and Approvers can tighten", async () => {
  assert.equal((await api(carol, "PATCH", `/agents/${s.clerk}`, { controls: { drafts: { perPayment: 0.8 } } })).status, 403);
  const tight = await api(dave, "PATCH", `/agents/${s.clerk}`, { controls: { drafts: { perPayment: 0.4 } } });
  assert.equal(tight.status, 200, JSON.stringify(tight.json));
  assert.equal(tight.json.agent.controls.drafts.perPayment, 0.4);
  assert.equal((await api(owner, "PATCH", `/agents/${s.clerk}`, { controls: { drafts: { perPayment: 0.5 } } })).status, 200);
  assert.equal((await api(carol, "PATCH", `/agents/${s.carolAgent}`, { abilities: { sandbox: false } })).status, 200, "creator tightens own agent");
  assert.equal((await api(carol, "PATCH", `/agents/${s.carolAgent}`, { abilities: { buy: true } })).status, 403, "but can't give it money");
});

test("onchain setup: the owner's wallet signs what the Clerk's settings need, and funds the treasury", async () => {
  const st = await api(owner, "GET", `/agents/${s.clerk}/onchain`);
  const descs = st.json.toSign.map((t: PreparedTx) => t.description).join(" | ");
  assert.match(descs, /draft payments/);
  assert.match(descs, /petty cash/);
  assert.match(descs, /network fees/);
  for (const tx of st.json.toSign as PreparedTx[]) await send(owner, tx);
  await send(owner, { chainId: 5042002, to: s.treasury, data: "0x", value: `0x${(3n * 10n ** 17n).toString(16)}`, description: "fund treasury 0.3" });
  const after2 = await api(owner, "GET", `/agents/${s.clerk}/onchain`);
  assert.equal(after2.json.inSync, true, JSON.stringify(after2.json));
  assert.equal(after2.json.isProposer, true);
  assert.equal(after2.json.pettyCashPerWeekUsd, 0.2);
});

test("chat (SSE): the owner asks the Clerk to draft; the draft is onchain and records who asked", async () => {
  const r = await sse(owner, `/agents/${s.clerk}/chat`, { message: `Draft a payment of 0.25 USDC to ${LENA} with memo "E2E invoice 1". Call propose_payment exactly once, then reply with the proposal id only.` });
  assert.equal(r.status, 200);
  assert.ok(!r.error, JSON.stringify(r.error));
  const result = r.steps.find((x) => x.type === "tool_result" && x.data.tool === "propose_payment");
  assert.ok(result, `no propose_payment result; steps: ${r.steps.map((x) => `${x.type}:${x.data?.tool ?? ""}`).join(",")}`);
  s.pid = Number(result.data.result.proposalId);
  const ps = await api(owner, "GET", ws("/proposals?status=open"));
  const p = ps.json.proposals.find((x: any) => x.id === s.pid);
  assert.equal(p.amountUsd, "0.25");
  assert.equal(p.draftedBy.name, "Clerk");
  assert.equal(p.requestedBy, s.ownerMember);
  assert.equal(p.you.canCosign, true);
});

test("a Viewer can talk to the team Clerk, but it won't draft for them; each person has their own conversation", async () => {
  const before = (await api(owner, "GET", ws("/proposals"))).json.proposals.length;
  const r = await sse(bob, `/agents/${s.clerk}/chat`, { message: `Draft a payment of 0.1 USDC to ${LENA}. If you can't, say so in one sentence.` });
  assert.equal(r.status, 200);
  assert.ok(!r.steps.some((x) => x.type === "tool_result" && x.data.tool === "propose_payment"), "no draft for a Viewer");
  assert.equal((await api(owner, "GET", ws("/proposals"))).json.proposals.length, before);
  const t = await api(bob, "GET", `/agents/${s.clerk}/thread`);
  const texts = t.json.messages.map((m: any) => m.text ?? "").join(" ");
  assert.ok(!texts.includes("E2E invoice 1"), "Bob doesn't see the owner's conversation");
});

test("cosign: only an onchain approver gets the approve transaction; the owner's wallet pays it", async () => {
  assert.equal((await api(bob, "GET", ws(`/proposals/${s.pid}/cosign`))).status, 403);
  assert.equal((await api(dave, "GET", ws(`/proposals/${s.pid}/cosign`))).status, 403, "Approver role but wallet not on the contract");
  const c = await api(owner, "GET", ws(`/proposals/${s.pid}/cosign`));
  assert.equal(c.status, 200);
  await send(owner, c.json.tx);
  const p = (await api(owner, "GET", ws("/proposals"))).json.proposals.find((x: any) => x.id === s.pid);
  assert.equal(p.status, "executed");
  assert.equal((await api(owner, "GET", ws(`/proposals/${s.pid}/cosign`))).status, 409);
});

test("approver change: Dave is added onchain through a cosigned proposal", async () => {
  const prep = await api(owner, "POST", ws("/approver-changes"), { kind: "add", address: dave.address });
  assert.equal(prep.status, 200);
  await send(owner, prep.json.tx);
  const open = (await api(owner, "GET", ws("/proposals?status=open"))).json.proposals.find((x: any) => x.kind === "add_approver" && x.to === dave.address);
  assert.ok(open);
  await send(owner, (await api(owner, "GET", ws(`/proposals/${open.id}/cosign`))).json.tx);
  const d = (await api(owner, "GET", ws("/members"))).json.find((m: any) => m.address === dave.address);
  assert.equal(d.onchainApprover, true);
  assert.equal(d.needsOnchainApprover, false);
});

test("Grok Bot: connect a routine with its webhook URL + key; a ping proves it", async () => {
  const g = await api(owner, "GET", `/agents/${s.clerk}/grokbot`);
  assert.equal(g.json.connection.status, "not_connected");
  assert.match(g.json.setupMessage, /Cosign: Clerk/);
  const wrong = await api(owner, "POST", `/agents/${s.clerk}/grokbot`, { webhookUrl: bot.url, webhookKey: "the-wrong-key-000", waitMs: 3000 });
  assert.equal(wrong.json.status, "failed");
  assert.match(wrong.json.error, /401/);
  assert.equal((await api(carol, "POST", `/agents/${s.clerk}/grokbot`, { webhookUrl: bot.url, webhookKey: "mock-webhook-key-123456" })).status, 403);
  const ok = await api(owner, "POST", `/agents/${s.clerk}/grokbot`, { webhookUrl: bot.url, webhookKey: "mock-webhook-key-123456", waitMs: 15000 });
  assert.equal(ok.json.status, "connected", JSON.stringify(ok.json));
});

test("Grok Bot task: every tool call goes through the same checks; a purchase above the line waits for a person", async () => {
  const t = await api(owner, "POST", `/agents/${s.clerk}/tasks`, {
    instructions: plan([
      { name: "get_balances" },
      { name: "propose_payment", args: { to: LENA, amount_usd: "0.2", memo: "bot draft" } },
      { name: "propose_payment", args: { to: LENA, amount_usd: "0.6", memo: "too big" } },
      { name: "propose_payment", args: { to: mallory.address, amount_usd: "0.1", memo: "not a payee" } },
      { name: "paid_fetch", args: { url: VENDOR_CHECK } },
      { name: "sandbox_bash", args: { command: "ls" } },
    ]),
  });
  assert.equal(t.status, 202);
  assert.equal(t.json.task.engine, "grokbot");
  const done = await taskDone(t.json.task.id);
  assert.equal(done.status, "done", JSON.stringify(done));
  const res = await botResults(t.json.task.id);
  const st = res.map((x: any) => `${x.name}:${x.status}`);
  assert.deepEqual(st, ["context:200", "get_balances:200", "propose_payment:200", "propose_payment:403", "propose_payment:403", "paid_fetch:200", "sandbox_bash:403"], JSON.stringify(res));
  assert.match(res[3].body.error, /per-payment cap/);
  assert.match(res[4].body.error, /allowed payees/);
  assert.equal(res[5].body.output.pending, true, JSON.stringify(res[5].body));
  assert.ok(done.progress.length >= 6, "progress callbacks arrived");
  s.approval = res[5].body.output.approvalRequestId;

  const list = await api(owner, "GET", ws("/approvals"));
  assert.ok(list.json.approvals.some((a: any) => a.id === s.approval && a.you.canDecide));
  assert.equal((await api(bob, "POST", ws(`/approvals/${s.approval}`), { decision: "approve" })).status, 403, "a Viewer can't OK purchases");
  assert.equal((await api(owner, "POST", ws(`/approvals/${s.approval}`), { decision: "approve" })).status, 200);

  const t2 = await api(owner, "POST", `/agents/${s.clerk}/tasks`, { instructions: plan([{ name: "paid_fetch", args: { url: VENDOR_CHECK } }]) });
  await taskDone(t2.json.task.id);
  const res2 = await botResults(t2.json.task.id);
  assert.equal(res2[1].status, 200, JSON.stringify(res2[1]));
  assert.equal(res2[1].body.output.paid?.amountUsd, "0.02", JSON.stringify(res2[1].body));
});

test("Grok Bot tokens: only for their own task, dead once the task is finished", async () => {
  const finished = bot.seen.find((x) => x.body.kind === "task" && x.results)!;
  assert.equal((await fetch(`${APP}/api/v1/bot/context`, { headers: { authorization: `Bearer ${finished.token}` } })).status, 409);
  const other = bot.seen.find((x) => x.body.task_id !== finished.body.task_id)!;
  const cross = await fetch(`${APP}/api/v1/bot/tasks/${other.body.task_id}/progress`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${finished.token}` }, body: "{}" });
  assert.equal(cross.status, 403);
  assert.equal((await fetch(`${APP}/api/v1/bot/context`, { headers: { authorization: "Bearer made-up-token" } })).status, 401);
});

test("a task a Viewer asks for can't move money, even through Grok Bot", async () => {
  const t = await api(bob, "POST", `/agents/${s.clerk}/tasks`, { instructions: plan([{ name: "propose_payment", args: { to: LENA, amount_usd: "0.1", memo: "bob" } }]) });
  assert.equal(t.status, 202);
  await taskDone(t.json.task.id, bob);
  const res = await botResults(t.json.task.id);
  assert.equal(res[1].status, 403);
  assert.match(res[1].body.error, /not allowed/);
});

test("schedules: stored here, fired by the tick, run by Grok Bot", async () => {
  assert.equal((await api(bob, "POST", `/agents/${s.clerk}/schedules`, { name: "x", instructions: "x", spec: { every: "day" } })).status, 403);
  const c = await api(owner, "POST", `/agents/${s.clerk}/schedules`, { name: "Daily balance check", instructions: plan([{ name: "get_balances" }]), spec: { every: "day", hour: 9, minute: 0 } });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  s.schedule = c.json.schedule.id;
  assert.ok(Date.parse(c.json.schedule.nextRunAt) > Date.now());
  assert.equal((await api(owner, "PATCH", `/schedules/${s.schedule}`, { nextRunAt: new Date(Date.now() - 60_000).toISOString() })).status, 200);
  assert.equal((await api(null, "POST", "/cron/tick", undefined, { "x-cron-secret": "wrong" })).status, 401);
  const tick = await api(null, "POST", "/cron/tick", undefined, { "x-cron-secret": process.env.CRON_SECRET ?? "" });
  assert.equal(tick.status, 200);
  const ran = tick.json.ran.find((r: any) => r.scheduleId === s.schedule);
  assert.equal(ran.engine, "grokbot", JSON.stringify(tick.json));
  const done = await taskDone(ran.taskId);
  assert.equal(done.status, "done");
  const again = await api(null, "POST", "/cron/tick", undefined, { "x-cron-secret": process.env.CRON_SECRET ?? "" });
  assert.ok(!again.json.ran.some((r: any) => r.scheduleId === s.schedule), "not due again until tomorrow");
});

test("no Bot connected: a task runs on our own agent loop (Carol's private agent)", async () => {
  const t = await api(carol, "POST", `/agents/${s.carolAgent}/tasks`, { instructions: "Save one memory note with slug e2e-check saying the end-to-end test ran today. Then reply with the single word DONE." });
  assert.equal(t.status, 202, JSON.stringify(t.json));
  assert.equal(t.json.task.engine, "cosign");
  const done = await taskDone(t.json.task.id, carol);
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.match(done.result ?? "", /DONE/i);
});

test("freeze stops money at once; only All access unfreezes", async () => {
  assert.equal((await api(dave, "POST", `/agents/${s.clerk}/freeze`)).status, 200, "an Approver can freeze");
  const t = await api(owner, "POST", `/agents/${s.clerk}/tasks`, { instructions: plan([{ name: "propose_payment", args: { to: LENA, amount_usd: "0.1", memo: "frozen?" } }]) });
  await taskDone(t.json.task.id);
  const res = await botResults(t.json.task.id);
  assert.equal(res[1].status, 403);
  assert.match(res[1].body.error, /not allowed|frozen/);
  assert.equal((await api(carol, "POST", `/agents/${s.clerk}/unfreeze`)).status, 403);
  assert.equal((await api(dave, "POST", `/agents/${s.clerk}/unfreeze`)).status, 403, "unfreezing is loosening: All access only");
  assert.equal((await api(owner, "POST", `/agents/${s.clerk}/unfreeze`)).status, 200);
});

test("activity feed answers for members; sweep returns the agent's wallet balance to the treasury", async () => {
  const a = await api(bob, "GET", ws("/activity"));
  assert.equal(a.status, 200);
  assert.ok(Array.isArray(a.json.activity));
  assert.equal((await api(carol, "POST", `/agents/${s.clerk}/sweep`)).status, 403);
  const sw = await api(owner, "POST", `/agents/${s.clerk}/sweep`);
  assert.equal(sw.status, 200, JSON.stringify(sw.json));
  assert.ok(Number(sw.json.swept) > 0, JSON.stringify(sw.json));
  assert.equal(sw.json.to, s.treasury);
});

test("retire: All access only; a retired agent can't be used", async () => {
  assert.equal((await api(carol, "POST", `/agents/${s.carolAgent}/retire`)).status, 403);
  const r = await api(owner, "POST", `/agents/${s.carolAgent}/retire`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const chat = await sse(carol, `/agents/${s.carolAgent}/chat`, { message: "hi" });
  assert.equal(chat.status, 403);
});
