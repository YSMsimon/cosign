import "./_env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONTROLS, loosens, mergeControls, PRESETS, type AgentRules } from "../../src/lib/agent/rules";
import { runToolChecked } from "../../src/lib/agent/tools";
import { db, schema } from "../../src/lib/db";
import { listTeamMessages } from "../../src/lib/server/team-feed";

// bridge, gateway_deposit, earn, borrow and request_funds: everything decided before Circle App Kit is called.
const LENA = "0x7797b992389e4a03e366daea33e71c0a394df1e7";
const VAULT = "0xaabbef1d3971c710276ed41ec791bbe14cdb8e88";
const MARKET = "0xf8a71f6df9dc7725d1c2fd848e4635d1e9ddca11da4e2dc2f9801005bd2b5d58";
const now = new Date().toISOString();
const WS = "ws_fund";
db().insert(schema.workspaces).values({ id: WS, name: "Nova Labs", treasury: "0x00000000000000000000000000000000000000dd", createdBy: "0x1", createdAt: now }).run();
db().insert(schema.roles).values([
  { id: "fr_appr", workspaceId: WS, key: "approver", name: "Approver", permissions: JSON.stringify(["payments.cosign"]), system: 1, createdAt: now },
  { id: "fr_mem", workspaceId: WS, key: null, name: "Member", permissions: JSON.stringify(["agents.use_team"]), system: 0, createdAt: now },
]).run();
db().insert(schema.members).values([
  { id: "fm_priya", workspaceId: WS, address: "0x00000000000000000000000000000000000000f1", roleId: "fr_appr", title: "Priya", invitedBy: null, createdAt: now, joinedAt: now },
  { id: "fm_jordan", workspaceId: WS, address: "0x00000000000000000000000000000000000000f2", roleId: "fr_mem", title: "Jordan", invitedBy: null, createdAt: now, joinedAt: now },
]).run();

const rules = (over: Partial<AgentRules["controls"]> = {}): AgentRules => ({
  abilities: { ...PRESETS.clerk, sandbox: false },
  controls: mergeControls(DEFAULT_CONTROLS, { purchases: { perPayment: 0.05, daily: 0.5 }, askAboveUsd: 0.03, allowedPayees: [LENA], ...over }),
});
let n = 0;
const ctx = (r: AgentRules) => ({ agentRef: "ref-appkit-test", treasury: "0x00000000000000000000000000000000000000dd" as const, rules: r, scope: { agentId: `ag_ak_${++n}`, workspaceId: WS, memberId: "fm_jordan" } });
const reason = (o: { status: string; reason?: string; output?: unknown }) => (o.status === "refused" ? o.reason ?? "" : JSON.stringify(o.output));

test("1. the new lists are controls: validated, normalised, and adding to them loosens", () => {
  const c = mergeControls(DEFAULT_CONTROLS, { allowedBridgeChains: ["Base_Sepolia"], earnVaults: [VAULT.toUpperCase().replace("0X", "0x")], borrowMarkets: [MARKET] });
  assert.deepEqual(c.allowedBridgeChains, ["Base_Sepolia"]);
  assert.deepEqual(c.earnVaults, [VAULT]);
  assert.throws(() => mergeControls(DEFAULT_CONTROLS, { earnVaults: ["not-an-address"] }), /bad earnVaults entry/);
  assert.throws(() => mergeControls(DEFAULT_CONTROLS, { borrowMarkets: ["0x12"] }), /bad borrowMarkets entry/);
  const a = rules();
  const why = loosens(a, { ...a, controls: { ...a.controls, allowedBridgeChains: ["Base_Sepolia"], earnVaults: [VAULT], borrowMarkets: [MARKET] } });
  for (const w of ["adds bridge chains", "adds earn vaults", "adds borrow markets"]) assert.ok(why.includes(w), w);
});

test("2. bridge: only allowed chains, only to a saved payee or its own wallet", async () => {
  assert.match(reason(await runToolChecked(ctx(rules()), "bridge", { to: LENA, chain: "Base_Sepolia", amount_usd: "0.01" })), /isn't allowed to bridge/);
  const r = rules({ allowedBridgeChains: ["Base_Sepolia"] });
  assert.match(reason(await runToolChecked(ctx(r), "bridge", { to: LENA, chain: "Ethereum_Sepolia", amount_usd: "0.01" })), /bridging to Ethereum_Sepolia isn't allowed/);
  assert.match(reason(await runToolChecked(ctx(r), "bridge", { to: "0x000000000000000000000000000000000000dEaD", chain: "Base_Sepolia", amount_usd: "0.01" })), /not one of this agent's allowed payees/);
});

test("3. earn needs an allowed vault; borrow is quotes only, and a loan is refused before App Kit is called", async () => {
  assert.match(reason(await runToolChecked(ctx(rules()), "earn", { action: "deposit", amount_usd: "0.01" })), /no Earn vaults allowed/);
  const r = rules({ earnVaults: [VAULT], borrowMarkets: [MARKET] });
  assert.match(reason(await runToolChecked(ctx(r), "earn", { action: "deposit", amount_usd: "0.01", vault: "0x0000000000000000000000000000000000000001" })), /isn't allowed/);
  assert.match(reason(await runToolChecked(ctx(r), "earn", { action: "dance" })), /action must be/);
  assert.match(reason(await runToolChecked(ctx(r), "earn", { action: "withdraw", amount_usd: "-1" })), /amount must be positive/);
  assert.match(reason(await runToolChecked(ctx(rules()), "borrow", { action: "quote", amount_usd: "1" })), /isn't allowed to look up borrowing/);
  // App Kit borrows only from smart-contract wallets; agent wallets are EOAs, so a loan never gets as far as asking a person
  const c = ctx(r);
  for (const action of ["borrow", "repay"]) assert.match(reason(await runToolChecked(c, "borrow", { action, amount_usd: "0.01" })), /smart-contract wallets/);
  assert.equal(db().select().from(schema.approvalRequests).all().filter((x) => x.agentId === c.scope.agentId).length, 0, "no approval request was opened");
});

test("4. gateway_deposit counts as a wallet payment: over the cap it is refused", async () => {
  assert.match(reason(await runToolChecked(ctx(rules()), "gateway_deposit", { amount_usd: "0.06" })), /per-payment cap \$0.05/);
});

test("5. request_funds asks an approver in the team feed and moves no money", async () => {
  const c = ctx(rules());
  const out = await runToolChecked(c, "request_funds", { amount_usd: "5.40", reason: "3 contractor payments are waiting and the treasury holds $1.50" });
  assert.equal(out.status, "ok", JSON.stringify(out));
  const o = out.output as { requested: boolean; requestId: string; asked: string };
  assert.equal(o.requested, true);
  assert.equal(o.asked, "Priya", "the approver is asked, not the member the agent works for");
  const row = db().select().from(schema.fundingRequests).all().find((x) => x.id === o.requestId)!;
  assert.equal(row.status, "pending");
  assert.equal(row.askedMemberId, "fm_priya");
  assert.ok(listTeamMessages(WS, 5).some((m) => m.toId === "fm_priya" && /needs about \$5\.40/.test(m.text)));
  assert.equal(db().select().from(schema.agentSpend).all().filter((x) => x.agentId === c.scope.agentId).length, 0, "nothing was spent");
});
