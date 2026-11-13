import "./_env";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { beforePurchase, checkLimits, moneyRefusal, recordSpend, type RunScope } from "../../src/lib/agent/controls";
import { DEFAULT_CONTROLS, mergeControls, PRESETS, type AgentRules } from "../../src/lib/agent/rules";
import { db, schema } from "../../src/lib/db";
import { NeedsApproval, PolicyRefusal } from "../../src/lib/x402/buyer";

const rules: AgentRules = {
  abilities: PRESETS.clerk,
  controls: mergeControls(DEFAULT_CONTROLS, {
    purchases: { perPayment: 0.05, daily: 0.1, weekly: 0.5, monthly: 1 },
    drafts: { perPayment: 5, daily: 8, weekly: 20, monthly: 50 },
    maxPaymentsPerHour: 3,
    askAboveUsd: 0.015,
    allowedSellers: ["localhost"],
  }),
};
let n = 0;
let scope: RunScope;
beforeEach(() => {
  scope = { agentId: `ag_test${++n}`, workspaceId: "ws_test", memberId: "mem_owner" };
});
const q = (price: number, url = "http://localhost:3000/api/sellers/vendor-check") => ({ priceUsd: price, host: "localhost", url });

test("1. per-payment cap, separately for purchases and drafts", () => {
  assert.match(checkLimits(rules, scope, "purchase", 0.06) ?? "", /per-payment cap \$0.05/);
  assert.equal(checkLimits(rules, scope, "purchase", 0.05), null);
  assert.equal(checkLimits(rules, scope, "draft", 4.99), null);
  assert.match(checkLimits(rules, scope, "draft", 5.01) ?? "", /draft of \$5.01 is over/);
});

test("2. rolling budgets count what the agent already spent", () => {
  recordSpend(scope, "purchase", 0.05, "a");
  recordSpend(scope, "purchase", 0.04, "b");
  assert.equal(checkLimits(rules, scope, "purchase", 0.01), null, "0.09 + 0.01 = the 0.10 daily budget");
  assert.match(checkLimits(rules, scope, "purchase", 0.02) ?? "", /daily purchase budget \$0.1 would be exceeded \(\$0.09 used\)/);
  recordSpend(scope, "draft", 7, "proposal:1");
  assert.match(checkLimits(rules, scope, "draft", 2) ?? "", /daily draft budget \$8/);
  // spend older than the window doesn't count
  const other: RunScope = { ...scope, agentId: `${scope.agentId}-old` };
  db().insert(schema.agentSpend).values({ agentId: other.agentId, kind: "purchase", amountUsd: "0.1", ref: "old", memberId: null, createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }).run();
  assert.equal(checkLimits(rules, other, "purchase", 0.05), null, "yesterday's spend is outside the daily window");
});

test("3. speed limit across purchases and drafts", () => {
  recordSpend(scope, "purchase", 0.001, "1");
  recordSpend(scope, "draft", 0.5, "2");
  assert.equal(checkLimits(rules, scope, "purchase", 0.001), null);
  recordSpend(scope, "purchase", 0.001, "3");
  assert.match(checkLimits(rules, scope, "purchase", 0.001) ?? "", /speed limit: at most 3 payments per hour/);
  recordSpend(scope, "topup", 1, "tx"); // petty cash isn't a payment for the speed limit
});

test("5. ask a person above $X: pending request, a member's OK lets exactly one purchase through", () => {
  assert.doesNotThrow(() => beforePurchase(rules, scope, q(0.01)), "below the line goes straight through");
  let reqId = "";
  try {
    beforePurchase(rules, scope, q(0.02));
    assert.fail("should wait for a person");
  } catch (e) {
    assert.ok(e instanceof NeedsApproval);
    reqId = (e as NeedsApproval).requestId;
  }
  // asking again reuses the same pending request
  assert.throws(() => beforePurchase(rules, scope, q(0.02)), (e: unknown) => e instanceof NeedsApproval && e.requestId === reqId);
  db().update(schema.approvalRequests).set({ status: "approved" }).run();
  assert.doesNotThrow(() => beforePurchase(rules, scope, q(0.02)), "approved: goes through once");
  assert.throws(() => beforePurchase(rules, scope, q(0.02)), NeedsApproval, "used up: the next one asks again");
  // an approval for a cheaper amount doesn't cover a pricier purchase
  db().update(schema.approvalRequests).set({ status: "approved", amountUsd: "0.016" }).run();
  assert.throws(() => beforePurchase(rules, scope, q(0.03)), NeedsApproval);
});

test("6. frozen or past the end date: every money action is refused", () => {
  assert.equal(moneyRefusal(rules), null);
  assert.match(moneyRefusal({ ...rules, controls: { ...rules.controls, frozen: true } }) ?? "", /frozen/);
  assert.match(moneyRefusal({ ...rules, controls: { ...rules.controls, expiresAt: "2001-01-01T00:00:00.000Z" } }) ?? "", /ended/);
  assert.throws(() => beforePurchase({ ...rules, controls: { ...rules.controls, frozen: true } }, scope, q(0.001)), PolicyRefusal);
});

test("without a scope (old script profiles) only the static caps apply", () => {
  assert.equal(checkLimits(rules, undefined, "purchase", 0.05), null);
  assert.match(checkLimits(rules, undefined, "purchase", 0.06) ?? "", /per-payment/);
});
