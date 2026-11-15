import { expect, test, type Page } from "@playwright/test";
import { api, signIn, startMockBot } from "../e2e/helpers";
import { pageApi, personFromKey, readState, signInThroughUi } from "./shared";

type Tasks = { tasks: { id: string; agentId: string; engine: string; status: string; instructions: string }[] };
type Funding = { requests: { id: string; status: string; amountUsd: string; reason: string }[] };
type Feed = { messages: { fromKind: string; fromId: string | null; toKind: string | null; text: string }[] };

async function ask(page: Page, text: string) {
  const box = page.getByPlaceholder("Message Clerk");
  await expect(box).toBeEditable({ timeout: 120_000 });
  await box.fill(text);
  await expect(page.getByRole("button", { name: "Send" })).toHaveAttribute("aria-disabled", "false", { timeout: 120_000 });
  await box.press("Enter");
}

test("Grok Bot and the onramp card: a job on the agent's Grok Bot routine is Grok Bot's turn; @mentions show; a funding request opens Circle's onramp", async ({ page, context }) => {
  test.setTimeout(420_000);
  const s = readState();
  const owner = personFromKey("owner", s.ownerKey);
  const tag = Date.now();

  // 1. the agent's background runs go to a Grok Bot routine (a stand-in that behaves like the real webhook routine)
  await signIn(owner);
  const KEY = "browser-mock-webhook-key-1234";
  const bot = startMockBot(4566, KEY);
  try {
    const c = await api(owner, "POST", `/agents/${s.agent}/grokbot`, { webhookUrl: bot.url, webhookKey: KEY, waitMs: 15_000 });
    expect(c.status, JSON.stringify(c.json)).toBe(200);

    await signInThroughUi(page, owner.account);
    // the @ list is the team: let it arrive before typing @ (as a person would)
    const team = page.waitForResponse((r) => r.url().endsWith(`/workspaces/${s.ws}/team`));
    await page.goto(`/chat?agent=${s.agent}`);
    await team;
    const box = page.getByPlaceholder("Message Clerk");
    await expect(box).toBeEditable();
    await page.waitForTimeout(800);
    await box.pressSequentially("@Gro", { delay: 60 });
    await page.getByRole("option", { name: /Grok Bot/ }).click({ timeout: 20_000 });
    const job = `check the balances for the browser test ${tag}`;
    await box.pressSequentially(job);
    await box.press("Enter");

    // it runs on Grok Bot (engine grokbot) and shows as Grok Bot's turn, with its own icon and the Background tag
    await expect
      .poll(async () => (await pageApi<Tasks>(page, "GET", `/workspaces/${s.ws}/tasks`)).json.tasks.find((t) => t.instructions.includes(job))?.status ?? null, { timeout: 60_000 })
      .toBe("done");
    const tasks = (await pageApi<Tasks>(page, "GET", `/workspaces/${s.ws}/tasks`)).json.tasks;
    expect(tasks.find((t) => t.instructions.includes(job))?.engine).toBe("grokbot");
    const turn = page.getByText(/Finished in the background · check the balances for the browser test/).last();
    await expect(turn).toBeVisible({ timeout: 30_000 });
    const grokTurn = page.locator('[data-slot="message"]').filter({ hasText: `browser test ${String(tag).slice(0, 6)}` }).last();
    await expect(grokTurn.locator('[data-slot="message-header"]')).toHaveText(/^Grok Bot\s*Background$/);
  } finally {
    await api(owner, "DELETE", `/agents/${s.agent}/grokbot`);
    await bot.close();
  }

  // 2. a team @mention from the agent shows in the conversation, the person as a chip
  await ask(page, `Use the mention tool now to tell Founder (the person on the team) "browser test ${tag} reached you". Then just say done.`);
  await expect
    .poll(async () => (await pageApi<Feed>(page, "GET", `/workspaces/${s.ws}/team/messages`)).json.messages.some((m) => m.fromId === s.agent && m.text.includes(`browser test ${tag}`)), { timeout: 120_000 })
    .toBe(true);
  await expect(page.getByText(`browser test ${tag} reached you`).last()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "@Founder" }).last()).toBeVisible();

  // 3. the agent asks for money for the treasury; the approver's card opens Circle's onramp in a new tab
  await ask(page, `The treasury needs $5 more to pay three contractors this week (${tag}). Use request_funds for $5.00 with that reason.`);
  const card = page.getByRole("alert").filter({ hasText: "Add $5.00 to the treasury?" }).last();
  await expect(card).toBeVisible({ timeout: 120_000 });
  const popup = context.waitForEvent("page");
  await card.getByRole("button", { name: "Approve" }).click();
  const tab = await popup;
  await tab.waitForURL((u) => u.hostname.endsWith("arc.io") || u.hostname.includes("circle"), { timeout: 45_000 });
  expect(new URL(tab.url()).hostname).toBe("onramp-sandbox.arc.io"); // Circle's sandbox onramp (testnet key); nothing is typed into it
  await tab.close();
  await expect(page.getByText("Opened Circle's onramp").last()).toBeVisible();
  const funding = (await pageApi<Funding>(page, "GET", `/workspaces/${s.ws}/funding-requests`)).json.requests;
  expect(funding.find((r) => r.reason.includes(String(tag)))?.status).toBe("opened");
});
