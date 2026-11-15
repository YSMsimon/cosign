import { expect, test, type Page } from "@playwright/test";
import { api, signIn, startMockBot } from "../e2e/helpers";
import { pageApi, personFromKey, readState, signInThroughUi } from "./shared";

type Thread = { messages: { kind: string; text?: string }[] };
type Tasks = { tasks: { id: string; engine: string; status: string; instructions: string }[] };

/** Type @ and pick someone from the room's list, then the rest of the message, and send it. */
async function askInRoom(page: Page, who: string, rest: string) {
  const box = page.getByPlaceholder(/^Message finance/);
  await expect(box).toBeEditable({ timeout: 120_000 });
  await box.click();
  await box.pressSequentially(`@${who.slice(0, 3)}`, { delay: 60 });
  await page.getByRole("option", { name: new RegExp(who) }).click({ timeout: 20_000 });
  await box.pressSequentially(rest);
  await expect(page.getByRole("button", { name: "Send" })).toHaveAttribute("aria-disabled", "false", { timeout: 120_000 });
  await box.press("Enter");
}

test("Rooms: an agent named in a room answers for real in the room's own thread, its words streaming in; @Grok Bot in a room starts a real job", async ({ page }) => {
  test.setTimeout(360_000);
  const s = readState();
  const owner = personFromKey("owner", s.ownerKey);
  const tag = Date.now();

  await signInThroughUi(page, owner.account);
  await page.goto("/chat?room=finance");
  await expect(page.getByText("Lena sent invoice 120 for the frontend work.")).toBeVisible({ timeout: 60_000 }); // the room's sample

  // 0. who's in the room is the real workspace: its real agent and Grok Bot in the @ list, none of the board's sample names
  const box = page.getByPlaceholder(/^Message finance/);
  await expect(box).toBeEditable({ timeout: 120_000 });
  await box.click();
  await box.pressSequentially("@", { delay: 60 });
  await expect(page.getByRole("option", { name: new RegExp(s.agentName) })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("option", { name: /Grok Bot/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Auditor|Scribe|Priya|Jordan|Sam/ })).toHaveCount(0);
  await box.press("Backspace");

  // 1. @Clerk in the room runs the real Clerk: "Thinking", then its words stream in (text_delta events), then its answer stays
  const turn = page.waitForResponse((r) => r.url().endsWith(`/agents/${s.agent}/chat`) && r.request().method() === "POST", { timeout: 60_000 });
  await askInRoom(page, s.agentName, ` reply with only the words room check ${tag}`);
  await expect(page.locator('[data-slot="message"]').last().getByText("Thinking")).toBeVisible({ timeout: 30_000 });
  const res = await turn;
  const body = await res.text(); // the whole stream, once the turn is over
  const deltas = body.match(/"type":"text_delta"/g)?.length ?? 0;
  expect(deltas, "the answer arrives in pieces as Grok writes it").toBeGreaterThan(0);
  expect(body).toContain("event: done");

  const answer = page.locator('[data-slot="message"]').filter({ hasText: `room check ${tag}` }).last();
  await expect(answer).toBeVisible({ timeout: 30_000 });
  await expect(answer.locator('[data-slot="message-header"]')).toHaveText(new RegExp(`^${s.agentName}`));
  await expect(answer.getByText(/^(Worked for \d+ s · )?\d+ steps?$/)).toHaveCount(0); // a plain answer has no tool steps

  // the room has its own thread with Clerk: none of it lands in your one-to-one chat
  const thread = await pageApi<Thread>(page, "GET", `/agents/${s.agent}/thread`);
  expect(thread.json.messages.some((m) => (m.text ?? "").includes(`room check ${tag}`)), "the room's turn stays out of the one-to-one chat").toBe(false);

  // ...and Clerk remembers the room's conversation inside the room
  await askInRoom(page, s.agentName, " what exact words did I just ask you to reply with? Answer with only those words.");
  await expect(page.locator('[data-slot="message"]').filter({ hasText: `room check ${tag}` })).toHaveCount(3, { timeout: 60_000 });

  // 2. @Grok Bot in the room: a real background job for the room's agent, followed in the room until Grok Bot reports
  await signIn(owner);
  const KEY = "browser-mock-webhook-key-room-1";
  const bot = startMockBot(4566, KEY);
  try {
    const c = await api(owner, "POST", `/agents/${s.agent}/grokbot`, { webhookUrl: bot.url, webhookKey: KEY, waitMs: 15_000 });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    const job = `check the balances for the room test ${tag}`;
    await askInRoom(page, "Grok Bot", ` ${job}`);
    await expect(page.getByText(new RegExp(`Finished in the background · check the balances for the room test`)).last()).toBeVisible({ timeout: 90_000 });
    const grokTurn = page.locator('[data-slot="message"]').filter({ hasText: "Finished in the background · check the balances for the room test" }).last();
    await expect(grokTurn.locator('[data-slot="message-header"]')).toHaveText(/^Grok Bot\s*Background$/);
    const tasks = (await pageApi<Tasks>(page, "GET", `/workspaces/${s.ws}/tasks`)).json.tasks;
    const t = tasks.find((x) => x.instructions.includes(job));
    expect(t?.engine).toBe("grokbot");
    expect(t?.status).toBe("done");
    expect(t?.instructions).not.toContain("@Grok Bot");
  } finally {
    await api(owner, "DELETE", `/agents/${s.agent}/grokbot`);
    await bot.close();
  }
});
