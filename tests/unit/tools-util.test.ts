import "./_env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONTROLS, effectiveAbilities, mergeControls, PRESETS, type AgentRules } from "../../src/lib/agent/rules";
import { runToolChecked, toolsFor, type AgentContext } from "../../src/lib/agent/tools";
import { recordSpend } from "../../src/lib/agent/controls";
import { decryptSecret, encryptSecret, nextRun, sha256, validateSpec } from "../../src/lib/server/util";

const LENA = "0x7797b992389e4a03e366daea33e71c0a394df1e7";
const TREASURY = "0x0000000000000000000000000000000000000abc";
const clerk: AgentRules = { abilities: PRESETS.clerk, controls: mergeControls(DEFAULT_CONTROLS, { allowedSellers: ["localhost"], allowedPayees: [LENA], drafts: { perPayment: 1, daily: 2, weekly: 5, monthly: 10 } }) };
const ctx = (rules: AgentRules, scope = true): AgentContext => ({
  agentRef: "agent-unit",
  treasury: TREASURY,
  rules,
  ...(scope ? { scope: { agentId: `ag_unit_${Math.random()}`, workspaceId: "ws", memberId: "mem" } } : {}),
});
const names = (c: AgentContext, only?: Set<string>) => toolsFor(c, only).map((t) => t.name);

test("a read-only agent is never offered a money tool", () => {
  const ro = names(ctx({ ...clerk, abilities: PRESETS.readonly }));
  for (const t of ["paid_fetch", "propose_payment", "request_topup", "discover_services"]) assert.ok(!ro.includes(t), t);
  assert.ok(ro.includes("get_balances") && ro.includes("memory_write") && ro.includes("sandbox_bash"));
  const noVm = names(ctx({ ...clerk, abilities: { ...PRESETS.readonly, sandbox: false } }));
  assert.ok(!noVm.includes("sandbox_bash") && noVm.includes("memory_read"), "memory works without the microVM");
});

test("the person asking narrows the agent: a Viewer gets no money tools from a clerk", () => {
  const viewer = ctx({ ...clerk, abilities: effectiveAbilities(clerk, { canRequestPayments: false }) });
  assert.ok(!names(viewer).includes("propose_payment"));
});

test("checked runner refuses before anything is signed", async () => {
  const c = ctx(clerk);
  const notPayee = await runToolChecked(c, "propose_payment", { to: "0x0000000000000000000000000000000000000001", amount_usd: "0.5", memo: "x" });
  assert.equal(notPayee.status, "refused");
  assert.match((notPayee as { reason: string }).reason, /not one of this agent's allowed payees/);
  const overCap = await runToolChecked(c, "propose_payment", { to: LENA, amount_usd: "1.5", memo: "x" });
  assert.match((overCap as { reason: string }).reason, /per-payment cap \$1/);
  recordSpend(c.scope, "draft", 1.8, "p");
  const overBudget = await runToolChecked(c, "propose_payment", { to: LENA, amount_usd: "0.5", memo: "x" });
  assert.match((overBudget as { reason: string }).reason, /daily draft budget \$2/);
  const frozen = await runToolChecked(ctx({ ...clerk, controls: { ...clerk.controls, frozen: true } }), "propose_payment", { to: LENA, amount_usd: "0.5", memo: "x" });
  assert.match((frozen as { reason: string }).reason, /frozen/);
  const seller = await runToolChecked(c, "paid_fetch", { url: "https://example.com/data" });
  assert.match((seller as { reason: string }).reason, /not on this agent's seller allowlist/);
  const topup = await runToolChecked(c, "request_topup", { amount_usd: "5" });
  assert.match((topup as { reason: string }).reason, /at most \$1/);
  const ro = await runToolChecked(ctx({ ...clerk, abilities: PRESETS.readonly }), "propose_payment", { to: LENA, amount_usd: "0.1", memo: "x" });
  assert.match((ro as { reason: string }).reason, /not allowed for this agent/);
  const bot = await runToolChecked(c, "sandbox_bash", { command: "ls" }, new Set(["get_balances"]));
  assert.match((bot as { reason: string }).reason, /not available here/);
  assert.equal((await runToolChecked(c, "nope", {})).status, "error");
});

test("secrets at rest round-trip and detect tampering; tokens are stored hashed", () => {
  const blob = encryptSecret("grok-webhook-key-123");
  assert.ok(!blob.includes("grok-webhook-key"));
  assert.equal(decryptSecret(blob), "grok-webhook-key-123");
  const parts = blob.split(".");
  parts[3] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => decryptSecret(parts.join(".")));
  assert.equal(sha256("abc").length, 64);
});

test("schedule times (UTC): hourly, daily, weekly, always strictly in the future", () => {
  const from = new Date("2026-11-13T10:30:00Z"); // a Friday
  assert.equal(nextRun({ every: "hour", minute: 45 }, from).toISOString(), "2026-11-13T10:45:00.000Z");
  assert.equal(nextRun({ every: "hour", minute: 15 }, from).toISOString(), "2026-11-13T11:15:00.000Z");
  assert.equal(nextRun({ every: "day", minute: 0, hour: 9 }, from).toISOString(), "2026-11-14T09:00:00.000Z");
  assert.equal(nextRun({ every: "day", minute: 0, hour: 12 }, from).toISOString(), "2026-11-13T12:00:00.000Z");
  assert.equal(nextRun({ every: "week", minute: 0, hour: 9, weekday: 1 }, from).toISOString(), "2026-11-16T09:00:00.000Z");
  assert.equal(nextRun({ every: "week", minute: 30, hour: 10, weekday: 5 }, from).toISOString(), "2026-11-20T10:30:00.000Z", "same moment → next week");
  assert.throws(() => validateSpec({ every: "month" as never }));
  assert.throws(() => validateSpec({ every: "day", hour: 25 }));
  assert.deepEqual(validateSpec({ every: "week" }), { every: "week", minute: 0, hour: 9, weekday: 1 });
});

test("list_allowed: payees from the contact book with notes, sellers with their catalog, one tool", async () => {
  const { db, schema } = await import("../../src/lib/db");
  db().insert(schema.contacts).values({ id: `ct_${Math.random()}`, workspaceId: "ws", name: "Lena (contractor)", address: LENA, notes: "invoices monthly", createdBy: null, createdAt: new Date().toISOString() }).onConflictDoNothing().run();
  const other = "0x00000000000000000000000000000000000000aa";
  const c = ctx({ ...clerk, controls: { ...clerk.controls, allowedPayees: [LENA, other], allowedSellers: ["localhost:1/api/sellers"] } });
  const payees = await runToolChecked(c, "list_allowed", { list: "payees" });
  assert.deepEqual(payees.output, { payees: [
    { name: "Lena (contractor)", address: LENA, notes: "invoices monthly" },
    { name: "saved payee (no contact name)", address: other, notes: null },
  ] });
  const sellers = (await runToolChecked(c, "list_allowed", { list: "vendors" })).output as { sellers: { seller: string; url: string; services: unknown }[] };
  assert.equal(sellers.sellers[0].url, "http://localhost:1/api/sellers");
  assert.match(String(sellers.sellers[0].services), /no catalog published/, "an unreachable seller still shows, with a hint");
  const all = (await runToolChecked(c, "list_allowed", {})).output as Record<string, unknown>;
  assert.ok("payees" in all && "sellers" in all, "default: both lists");
  assert.equal((await runToolChecked(c, "list_allowed", { list: "nope" })).status, "error");
  const ro = ctx({ ...clerk, abilities: PRESETS.readonly });
  assert.ok(names(ro).includes("list_allowed"), "a read tool: every agent may look");
  assert.match(String(((await runToolChecked(ro, "list_allowed", { list: "sellers" })).output as { sellers: string }).sellers), /paid APIs are off/);
});

test("voice turns: every tool requires a say_first sentence, and the tool never sees it", async () => {
  const { xaiTools, takeSayFirst } = await import("../../src/lib/agent/tools");
  const fns = xaiTools(ctx(clerk), { sayFirst: true }).filter((t) => t.type === "function") as { parameters: { required: string[]; properties: Record<string, unknown> } }[];
  for (const f of fns) assert.ok(f.parameters.required[0] === "say_first" && "say_first" in f.parameters.properties);
  const chat = xaiTools(ctx(clerk)).filter((t) => t.type === "function") as { parameters: { properties: Record<string, unknown> } }[];
  assert.ok(chat.every((f) => !("say_first" in f.parameters.properties)), "text chat is unchanged");
  const args: Record<string, unknown> = { say_first: " I'll check. ", url: "x" };
  assert.equal(takeSayFirst(args), "I'll check.");
  assert.deepEqual(args, { url: "x" });
});
