import "./_env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONTROLS, loosens, mergeControls, PRESETS, type AgentRules } from "../../src/lib/agent/rules";
import { runToolChecked, toolsFor } from "../../src/lib/agent/tools";
import { db, schema } from "../../src/lib/db";

// send_usdc and swap: everything that is decided before Circle App Kit is called (no network in unit tests).
const LENA = "0x7797b992389e4a03e366daea33e71c0a394df1e7";
const rules = (over: Partial<AgentRules["controls"]> = {}, buy = true): AgentRules => ({
  abilities: { ...PRESETS.clerk, buy, sandbox: false },
  controls: mergeControls(DEFAULT_CONTROLS, { purchases: { perPayment: 0.05, daily: 0.5 }, askAboveUsd: 0.03, allowedPayees: [LENA], ...over }),
});
let n = 0;
const ctx = (r: AgentRules) => ({
  agentRef: "ref-wallet-test",
  treasury: "0x00000000000000000000000000000000000000cc" as const,
  rules: r,
  scope: { agentId: `ag_wallet_${++n}`, workspaceId: "ws_wallet", memberId: "mem_wallet" },
});
const reason = (o: { status: string; reason?: string; output?: unknown }) => (o.status === "refused" ? o.reason ?? "" : JSON.stringify(o.output));

test("1. swap tokens and the price limit are controls: validated, normalised, and loosening them is flagged", () => {
  assert.deepEqual(mergeControls(DEFAULT_CONTROLS, { allowedSwapTokens: ["eurc", "EURC"] }).allowedSwapTokens, ["EURC"]);
  assert.throws(() => mergeControls(DEFAULT_CONTROLS, { allowedSwapTokens: ["DOGE"] }), /can't swap to "DOGE"/);
  assert.throws(() => mergeControls(DEFAULT_CONTROLS, { maxSlippageBps: -1 }), /maxSlippageBps/);
  assert.equal(DEFAULT_CONTROLS.maxSlippageBps, 300);
  const a = rules();
  assert.ok(loosens(a, { ...a, controls: { ...a.controls, allowedSwapTokens: ["EURC"] } }).includes("adds swap tokens"));
  assert.ok(loosens(a, { ...a, controls: { ...a.controls, maxSlippageBps: 1000 } }).includes("raises maxSlippageBps"));
  // controls saved before these fields existed fall back to the defaults
  const old = { ...DEFAULT_CONTROLS } as Partial<AgentRules["controls"]>;
  delete old.allowedSwapTokens;
  delete old.maxSlippageBps;
  const merged = mergeControls(old as AgentRules["controls"], {});
  assert.deepEqual(merged.allowedSwapTokens, []);
  assert.equal(merged.maxSlippageBps, 300);
});

test("2. both tools belong to the wallet ability: offered with it, never without it", () => {
  const names = (r: AgentRules) => toolsFor(ctx(r)).map((t) => t.name);
  assert.ok(names(rules()).includes("send_usdc") && names(rules()).includes("swap"));
  assert.ok(!names(rules({}, false)).includes("send_usdc") && !names(rules({}, false)).includes("swap"));
});

test("3. send_usdc: only to saved payees, inside the wallet limits, and above the ask-a-person line it waits", async () => {
  const r = rules();
  assert.match(reason(await runToolChecked(ctx(r), "send_usdc", { to: "0x000000000000000000000000000000000000dEaD", amount_usd: "0.01", memo: "x" })), /not one of this agent's allowed payees/);
  assert.match(reason(await runToolChecked(ctx(r), "send_usdc", { to: LENA, amount_usd: "0", memo: "x" })), /amount must be positive/);
  assert.match(reason(await runToolChecked(ctx(r), "send_usdc", { to: LENA, amount_usd: "0.06", memo: "x" })), /per-payment cap \$0.05/);
  const c = ctx(r);
  const pending = await runToolChecked(c, "send_usdc", { to: LENA, amount_usd: "0.04", memo: "x" });
  assert.equal(pending.status, "ok");
  assert.equal((pending.output as { pending?: boolean }).pending, true, "above the $0.03 line it waits for a member");
  const req = db().select().from(schema.approvalRequests).all().find((x) => x.agentId === c.scope.agentId)!;
  assert.equal(req.url, `send:${LENA}`);
});

test("4. swap: only allowed tokens, and over the limits it is refused before App Kit is asked", async () => {
  assert.match(reason(await runToolChecked(ctx(rules()), "swap", { token_out: "EURC", amount_usd: "0.01" })), /isn't allowed to swap/);
  const r = rules({ allowedSwapTokens: ["EURC"] });
  assert.match(reason(await runToolChecked(ctx(r), "swap", { token_out: "cirBTC", amount_usd: "0.01" })), /swapping to cirBTC isn't allowed \(allowed: EURC\)/);
  assert.match(reason(await runToolChecked(ctx(r), "swap", { token_out: "EURC", amount_usd: "0.06" })), /per-payment cap \$0.05/);
  const frozen = rules({ allowedSwapTokens: ["EURC"], frozen: true });
  assert.match(reason(await runToolChecked(ctx(frozen), "swap", { token_out: "EURC", amount_usd: "0.01" })), /frozen/);
});
