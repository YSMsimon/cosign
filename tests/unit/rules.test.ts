import "./_env";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CONTROLS, effectiveAbilities, loosens, mergeAbilities, mergeControls, moneyLive, normalizeSeller, PRESETS, rulesFromPolicy, rulesMarkdown, RulesError, sellerAllowed,
  type AgentRules,
} from "../../src/lib/agent/rules";

const LENA = "0x7797b992389e4a03e366daea33e71c0a394df1e7";
const base: AgentRules = { abilities: PRESETS.clerk, controls: mergeControls(DEFAULT_CONTROLS, { allowedSellers: ["localhost"], allowedPayees: [LENA] }) };

test("presets: read-only has no money abilities; clerk can buy, draft and draw petty cash", () => {
  assert.deepEqual(PRESETS.readonly, { sandbox: true, buy: false, draft: false, pettyCash: false });
  assert.deepEqual(PRESETS.clerk, { sandbox: true, buy: true, draft: true, pettyCash: true });
});

test("caps must nest: per-payment ≤ daily ≤ weekly ≤ monthly", () => {
  assert.throws(() => mergeControls(DEFAULT_CONTROLS, { purchases: { perPayment: 1, daily: 0.5 } }), RulesError);
  assert.throws(() => mergeControls(DEFAULT_CONTROLS, { drafts: { weekly: 1000, monthly: 10 } }), RulesError);
  const ok = mergeControls(DEFAULT_CONTROLS, { purchases: { perPayment: 0.1, daily: null, weekly: 1 } });
  assert.deepEqual(ok.purchases, { perPayment: 0.1, daily: null, weekly: 1, monthly: 5 });
});

test("bad values are rejected: negative caps, bad hosts, bad payee addresses, bad dates", () => {
  assert.throws(() => mergeControls(DEFAULT_CONTROLS, { askAboveUsd: -1 }), RulesError);
  assert.throws(() => mergeControls(DEFAULT_CONTROLS, { allowedSellers: ["evil.com/x?y=1"] }), RulesError);
  assert.throws(() => mergeControls(DEFAULT_CONTROLS, { allowedSellers: ["evil com"] }), RulesError);
  assert.throws(() => mergeControls(DEFAULT_CONTROLS, { allowedPayees: ["0x123"] }), RulesError);
  assert.throws(() => mergeControls(DEFAULT_CONTROLS, { expiresAt: "next tuesday" }), RulesError);
  const c = mergeControls(DEFAULT_CONTROLS, { allowedSellers: ["LocalHost", "localhost"], allowedPayees: [LENA.toUpperCase().replace("0X", "0x")] });
  assert.deepEqual(c.allowedSellers, ["localhost"]);
  assert.deepEqual(c.allowedPayees, [LENA]);
});

test("loosening is detected: higher or removed caps, new payees/sellers, abilities on, unfreeze, later end date", () => {
  const with_ = (patch: object, abil?: object): AgentRules => ({ abilities: mergeAbilities(base.abilities, abil), controls: mergeControls(base.controls, patch) });
  assert.deepEqual(loosens(base, with_({ drafts: { perPayment: 4 } })), [], "lowering a cap is tightening");
  assert.ok(loosens(base, with_({ drafts: { perPayment: 6, daily: 20 } })).includes("raises drafts.perPayment"));
  assert.ok(loosens(base, with_({ purchases: { monthly: null } })).includes("raises purchases.monthly"));
  assert.ok(loosens(base, with_({ allowedPayees: [LENA, "0x0000000000000000000000000000000000000001"] })).includes("adds payees"));
  assert.ok(loosens(base, with_({ allowedSellers: ["localhost", "x402.quicknode.com"] })).includes("adds sellers"));
  assert.deepEqual(loosens(base, with_({ allowedSellers: [] })), [], "removing a seller is tightening");
  const ro: AgentRules = { abilities: PRESETS.readonly, controls: base.controls };
  assert.ok(loosens(ro, { ...ro, abilities: PRESETS.buyer }).includes("turns on buy"));
  const frozen = with_({ frozen: true });
  assert.ok(loosens(frozen, base).includes("unfreezes"));
  assert.deepEqual(loosens(base, frozen), []);
  const ends = with_({ expiresAt: "2030-01-01T00:00:00Z" });
  assert.ok(loosens(ends, with_({ expiresAt: null })).includes("extends the end date"));
  assert.ok(loosens(with_({ askAboveUsd: 1 }), with_({ askAboveUsd: null })).includes("raises askAboveUsd"));
});

test("money abilities switch off when frozen, after the end date, or when the person asking can't request payments", () => {
  assert.equal(moneyLive(base.controls), true);
  assert.equal(moneyLive({ ...base.controls, frozen: true }), false);
  assert.equal(moneyLive({ ...base.controls, expiresAt: "2000-01-01T00:00:00.000Z" }), false);
  assert.deepEqual(effectiveAbilities(base, { canRequestPayments: true }), PRESETS.clerk);
  assert.deepEqual(effectiveAbilities(base, { canRequestPayments: false }), { sandbox: true, buy: false, draft: false, pettyCash: false });
  assert.deepEqual(effectiveAbilities({ ...base, controls: { ...base.controls, frozen: true } }, { canRequestPayments: true }), { sandbox: true, buy: false, draft: false, pettyCash: false });
});

test("old script profiles map onto rules", () => {
  const r = rulesFromPolicy({ maxPerCallUsd: 0, allowedHosts: [], maxProposalUsd: 0, allowedPayees: [], maxTopUpUsd: 0, sandbox: true });
  assert.deepEqual(r.abilities, PRESETS.readonly);
  const c = rulesFromPolicy({ maxPerCallUsd: 0.05, allowedHosts: ["localhost"], maxProposalUsd: 5, allowedPayees: [LENA as `0x${string}`], maxTopUpUsd: 1, sandbox: true });
  assert.deepEqual(c.abilities, PRESETS.clerk);
  assert.equal(c.controls.drafts.perPayment, 5);
});

test("the agent reads its own rules in policy.md", () => {
  const md = rulesMarkdown("Clerk", base, [{ name: "Lena", address: LENA }]);
  assert.match(md, /per payment \$5/);
  assert.match(md, /Lena \(0x7797/);
  assert.match(rulesMarkdown("Clerk", { ...base, controls: { ...base.controls, frozen: true } }, []), /OFF right now \(frozen\)/);
  assert.match(rulesMarkdown("Auditor", { abilities: PRESETS.readonly, controls: base.controls }, []), /Abilities: sandbox/);
});

test("seller allowlist: a bare host never opens other ports; ports and paths must match", () => {
  const list = ["localhost:3000/api/sellers", "x402.quicknode.com"];
  const ok = (url: string) => sellerAllowed(list, url).ok;
  assert.ok(ok("http://localhost:3000/api/sellers/invoice-reader?invoice=120"));
  assert.ok(ok("http://localhost:3000/api/sellers"));
  assert.ok(ok("https://x402.quicknode.com/arc-testnet"));
  // what a Grok Bot run actually tried on 2026-11-13: other local ports, other paths on our app
  assert.ok(!ok("http://localhost:4040/api/requests/http")); // ngrok inspector
  assert.ok(!ok("http://localhost:4400/")); // another local app
  assert.ok(!ok("http://localhost:3000/settings"));
  assert.ok(!ok("http://localhost:3000/api/v1/me"));
  assert.ok(!ok("http://localhost:3000/api/sellersX/evil"));
  assert.ok(!ok("http://127.0.0.1:3000/api/sellers/vendor-check")); // a different host spelling is a different entry
  assert.ok(!ok("https://x402.quicknode.com:8443/")); // bare host = default port only
  assert.ok(!ok("http://x402.quicknode.com/")); // plain http only for loopback
  assert.ok(!ok("https://user:pw@x402.quicknode.com/"));
  assert.ok(!ok("https://x402.quicknode.com.evil.io/"));
  assert.ok(!ok("file:///etc/passwd"));
  assert.ok(!sellerAllowed(["localhost"], "http://localhost:3000/").ok);
  assert.equal(normalizeSeller(" HTTP://LocalHost:3000/api/sellers/ "), "localhost:3000/api/sellers");
  assert.deepEqual(mergeControls(DEFAULT_CONTROLS, { allowedSellers: ["LocalHost:3000/api/sellers/"] }).allowedSellers, ["localhost:3000/api/sellers"]);
  assert.throws(() => mergeControls(DEFAULT_CONTROLS, { allowedSellers: ["localhost:3000/a b"] }));
});
