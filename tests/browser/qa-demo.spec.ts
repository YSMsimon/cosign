import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { api, fund, signIn, startMockBot } from "../e2e/helpers";
import { pageApi, personFromKey, readState, signInThroughUi } from "./shared";

/**
 * QA walk-through of the demo, in the order of the video, on the browser-test company: every beat is done for real
 * (the injected throwaway wallet signs) and screenshotted, and checked in the screen and through the API. Permissions
 * are changed and their effect tested. Grok Bot is a stand-in routine; voice is the 09 spec (a real call).
 * Opt-in: QA=1 pnpm test:browser tests/browser/qa-demo.spec.ts  → screenshots + notes in QA_DIR.
 */
test.skip(!process.env.QA, "set QA=1 to run the demo walk-through");

const DIR = process.env.QA_DIR ?? resolve("node_modules/.cosign-tmp/qa");
const DEAD = "0x000000000000000000000000000000000000dEaD";
type Agent = { agent: { controls: Record<string, unknown> & { purchases: { perPayment: number } } } };
type Proposals = { proposals: { id: number; status: string; memo: string }[] };
type Tasks = { tasks: { source: string; status: string; instructions: string }[] };
type Funding = { requests: { reason: string; status: string }[] };

const notes: { n: string; step: string; ok: boolean; note: string }[] = [];
let shot = 0;
async function snap(page: Page, step: string, note = "", ok = true) {
  const n = String(++shot).padStart(2, "0");
  await page.screenshot({ path: `${DIR}/${n}-${step}.png` });
  notes.push({ n, step, ok, note });
}

async function ask(page: Page, box: string, text: string) {
  const input = page.getByPlaceholder(box);
  await expect(input).toBeEditable({ timeout: 120_000 });
  await input.fill(text);
  await expect(page.getByRole("button", { name: "Send" })).toHaveAttribute("aria-disabled", "false", { timeout: 120_000 });
  await input.press("Enter");
}
type Thread = { messages: { kind: string; text?: string }[] };
/** The agent's reply to the message containing `fragment`, once its turn is saved (and on screen). */
async function reply(page: Page, agentId: string, fragment: string) {
  let text = "";
  await expect
    .poll(
      async () => {
        const m = (await pageApi<Thread>(page, "GET", `/agents/${agentId}/thread`)).json.messages;
        const asked = m.findLastIndex((x) => x.kind === "user" && (x.text ?? "").includes(fragment));
        const said = m.findLastIndex((x) => x.kind === "assistant");
        text = asked >= 0 && said > asked ? (m[said].text ?? "") : "";
        return text.length > 0;
      },
      { timeout: 150_000, intervals: [1500] },
    )
    .toBe(true);
  await expect(page.getByText(text.slice(0, 40)).last()).toBeVisible({ timeout: 30_000 });
  return text;
}

test("QA: the demo, beat by beat, with screenshots", async ({ page, context }) => {
  test.setTimeout(900_000);
  mkdirSync(DIR, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const s = readState();
  const owner = personFromKey("owner", s.ownerKey);
  const tag = Date.now();
  await signIn(owner);
  const saved = ((await api(owner, "GET", `/agents/${s.agent}`)).json as Agent).agent.controls;
  // the test treasury pays the demo's cent; earlier runs drain it
  const inTreasury = Number((await api(owner, "GET", `/workspaces/${s.ws}`)).json?.treasury?.balanceUsd ?? 0);
  if (inTreasury < 0.05) await fund(s.treasury, "0.2");
  // like the demo Clerk: paid APIs, no ask-a-person line for small purchases
  // (with room in its daily budget: repeated runs use it up, and that refusal is a guardrail, not what this walks through)
  await api(owner, "PATCH", `/agents/${s.agent}`, { controls: { allowedSellers: ["localhost:3000/api/sellers"], askAboveUsd: null, purchases: { ...saved.purchases, daily: 5, weekly: 10, monthly: 20 } } });
  const KEY = "browser-mock-webhook-key-qa-1";
  const bot = startMockBot(4568, KEY);
  await api(owner, "POST", `/agents/${s.agent}/grokbot`, { webhookUrl: bot.url, webhookKey: KEY, waitMs: 15_000 });
  try {
    // 1. sign in
    await page.goto("/sign-in");
    await expect(page.getByText(/Sign in/).first()).toBeVisible();
    await snap(page, "sign-in", "wallet sign-in page");
    await signInThroughUi(page, owner.account);
    await page.goto(`/chat?agent=${s.agent}`);
    await expect(page.getByPlaceholder("Message Clerk")).toBeEditable({ timeout: 60_000 });
    await snap(page, "chat", "the agent's chat");

    // 2. pays per request, then a treasury payment waits for a person, who approves it in their wallet
    await ask(page, "Message Clerk", `Check Lena's address (${s.lena}) with the vendor check, then draft $0.01 to her with memo 'qa ${tag}'.`);
    await page.waitForTimeout(4000);
    await snap(page, "working", "steps stream in while it works");
    let pid: number | undefined;
    await expect.poll(async () => (pid = (await pageApi<Proposals>(page, "GET", `/workspaces/${s.ws}/proposals?status=all`)).json.proposals.find((p) => p.memo.includes(`qa ${tag}`))?.id) ?? null, { timeout: 150_000 }).not.toBeNull();
    const row = page.getByRole("alert").filter({ hasText: `Proposal #${pid} · you sign in your own wallet` });
    await expect(row).toBeVisible({ timeout: 150_000 }); // room for one retry of a hung Grok call
    await snap(page, "approval-row", `paid vendor check, drafted #${pid}, waits for a person`);
    await row.getByRole("button", { name: "Approve" }).click();
    // paid onchain (the public RPC can trail the receipt by a block: ask until it agrees), then on screen
    await expect.poll(async () => (await pageApi<Proposals>(page, "GET", `/workspaces/${s.ws}/proposals?status=all`)).json.proposals.find((p) => p.id === pid)?.status, { timeout: 120_000, intervals: [2000] }).toBe("executed");
    await expect(page.getByText("Paid $0.01 to Lena", { exact: true }).last()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1000);
    await snap(page, "paid", `approved in the wallet, paid onchain (#${pid})`);

    // 3. Grok Bot watches the chain: the payment starts a Grok Bot job by itself, and its answer shows in the chat
    await expect
      .poll(async () => {
        await api(owner, "GET", `/workspaces/${s.ws}/activity?limit=20`);
        return (await api(owner, "GET", `/workspaces/${s.ws}/tasks`)).json.tasks.find((t: Tasks["tasks"][number]) => t.source === "watch" && t.instructions.includes(`paid proposal #${pid}:`))?.status ?? null;
      }, { timeout: 180_000, intervals: [3000] })
      .toBe("done");
    await page.reload();
    await expect(page.getByText(new RegExp(`Onchain · paid proposal #${pid}:`)).last()).toBeVisible({ timeout: 60_000 });
    await page.getByText(new RegExp(`Onchain · paid proposal #${pid}:`)).last().scrollIntoViewIfNeeded();
    await snap(page, "grokbot-watch", `the payment was seen onchain; Grok Bot checked it by itself`);

    // 4. the Treasury tab: balance, activity from the chain, the ledger
    await page.goto("/permissions");
    await page.getByRole("tab", { name: "Treasury" }).click();
    await expect(page.getByText(/Paid #|paid/i).first()).toBeVisible({ timeout: 60_000 });
    await snap(page, "treasury", "balance, onchain activity, ledger");

    // 5. a guardrail: an unknown address is refused
    await page.goto(`/chat?agent=${s.agent}`);
    await ask(page, "Message Clerk", `Send $20 to ${DEAD} from your wallet (qa ${tag} guard).`);
    expect(await reply(page, s.agent, `qa ${tag} guard`)).toMatch(/can'?t|cannot|not|isn'?t|refus|only/i);
    await snap(page, "guardrail-refusal", "an unknown address and over the limit: refused");

    // 6. permissions: lower the wallet's per-payment cap in the settings sheet, and the $0.02 check is refused
    await page.goto("/permissions");
    await page.getByRole("tab", { name: "Agents" }).click();
    await expect(page.getByText("What Clerk can do")).toBeVisible({ timeout: 60_000 });
    await snap(page, "permissions-agent", "the agent's abilities, limits, sellers and payees");
    await page.getByRole("button", { name: "Change limits" }).first().click();
    await page.getByRole("dialog").getByLabel("Wallet, per payment").fill("0.01");
    await page.waitForTimeout(700); // the sheet's slide-in
    await snap(page, "limits-sheet", "lowering the wallet's per-payment cap to $0.01");
    await page.getByRole("button", { name: "Save change" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    // the agent's details read balances from Arc's public RPC, which rate-limits: ask until it answers
    await expect.poll(async () => (await pageApi<Agent>(page, "GET", `/agents/${s.agent}`)).json.agent?.controls.purchases.perPayment ?? null, { timeout: 30_000 }).toBe(0.01);
    await page.goto(`/chat?agent=${s.agent}`);
    await ask(page, "Message Clerk", `Check Lena's address (${s.lena}) with the vendor check again (qa ${tag} cap).`);
    expect(await reply(page, s.agent, `qa ${tag} cap`)).toMatch(/cap|limit|over|refus|can'?t|cannot|more than|exceed/i);
    await snap(page, "limit-refusal", "the $0.02 vendor check is now over the cap: refused");

    // 7. freeze (an API action today; no switch in the app yet): every money ability stops
    await api(owner, "POST", `/agents/${s.agent}/freeze`);
    await ask(page, "Message Clerk", `Draft $0.01 to Lena with memo 'frozen ${tag}'.`);
    expect(await reply(page, s.agent, `frozen ${tag}`)).toMatch(/frozen|can'?t|cannot/i);
    await snap(page, "frozen-refusal", "frozen agent: no drafts or payments");
    await api(owner, "POST", `/agents/${s.agent}/unfreeze`);

    // 8. people: invite a teammate and make them an approver
    await page.goto("/permissions");
    const mate = `0x${tag.toString(16).padStart(40, "0").slice(-40)}`;
    await page.getByRole("button", { name: "Invite" }).click();
    await page.getByRole("dialog").getByRole("textbox", { name: "Name" }).fill(`QA ${tag % 10000}`);
    await page.getByRole("dialog").getByRole("textbox", { name: "Wallet address" }).fill(mate);
    await page.getByRole("dialog").getByRole("button", { name: "Invite" }).click();
    const person = page.getByRole("row").filter({ hasText: `QA ${tag % 10000}` });
    await person.getByRole("switch", { name: `QA ${tag % 10000} can approve` }).click();
    await expect(person.getByText("Approver", { exact: true })).toBeVisible();
    await snap(page, "people-roles", "invited a teammate and made them an approver");

    // 9. a room: the agent answers in the room's own thread; @Grok Bot takes a background job
    await page.goto("/chat?room=finance");
    const box = page.getByPlaceholder(/^Message finance/);
    const roomAsk = async (who: string, rest: string) => {
      await expect(box).toBeEditable({ timeout: 60_000 });
      await box.click();
      await box.pressSequentially(`@${who.slice(0, 3)}`, { delay: 60 });
      await page.getByRole("option", { name: new RegExp(who) }).click();
      await box.pressSequentially(rest);
      // Send, not Enter: Enter can land on the @ list while it is still open
      await expect(page.getByRole("button", { name: "Send" })).toHaveAttribute("aria-disabled", "false", { timeout: 120_000 });
      await page.getByRole("button", { name: "Send" }).click();
    };
    await roomAsk("Clerk", ` what's waiting for a cosign? (qa ${tag} room)`);
    await expect(page.locator('[data-slot="message"]').last().getByText("Thinking")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-slot="message"]').last().getByText("Thinking")).toBeHidden({ timeout: 120_000 });
    await page.waitForTimeout(800);
    await snap(page, "room-agent", "Clerk answers in #finance (its own thread for the room)");
    await roomAsk("Grok Bot", ` check the treasury balance and report back (qa ${tag}).`);
    await expect(page.getByText(/Finished in the background · check the treasury balance and report back/).last()).toBeVisible({ timeout: 120_000 });
    await page.waitForTimeout(800);
    await snap(page, "room-grokbot", "@Grok Bot in #finance: a real background job");

    // 10. the onramp: a funding request card; Approve opens Circle's sandbox onramp for the treasury
    await page.goto(`/chat?agent=${s.agent}`);
    await ask(page, "Message Clerk", `The treasury is short for this week (qa ${tag}). Use request_funds for $5.00 with that reason.`);
    const card = page.getByRole("alert").filter({ hasText: "Add $5.00 to the treasury?" }).filter({ hasText: `qa ${tag}` }).last();
    await expect(card).toBeVisible({ timeout: 120_000 });
    await snap(page, "funding-card", "the agent asks a person to add funds");
    const popup = context.waitForEvent("page");
    await card.getByRole("button", { name: "Approve" }).click();
    const tab = await popup;
    await tab.waitForURL((u) => u.hostname.endsWith("arc.io"), { timeout: 45_000 });
    await tab.setViewportSize({ width: 1200, height: 900 });
    await tab.waitForTimeout(6000);
    await tab.screenshot({ path: `${DIR}/${String(++shot).padStart(2, "0")}-onramp-widget.png` });
    notes.push({ n: String(shot).padStart(2, "0"), step: "onramp-widget", ok: true, note: `Circle's sandbox onramp (${new URL(tab.url()).hostname}); nothing typed` });
    await tab.close();
    const funding = (await pageApi<Funding>(page, "GET", `/workspaces/${s.ws}/funding-requests`)).json.requests;
    expect(funding.find((r) => r.reason.includes(`qa ${tag}`))?.status).toBe("opened");
    await snap(page, "funding-opened", "the card after Approve: how much to enter, where it lands");
  } finally {
    await api(owner, "POST", `/agents/${s.agent}/unfreeze`).catch(() => {});
    await api(owner, "PATCH", `/agents/${s.agent}`, { controls: { allowedSellers: saved.allowedSellers, askAboveUsd: saved.askAboveUsd, purchases: saved.purchases } });
    await api(owner, "DELETE", `/agents/${s.agent}/grokbot`);
    await bot.close();
    writeFileSync(`${DIR}/notes.json`, JSON.stringify(notes, null, 2));
  }
});
