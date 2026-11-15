import { expect, test } from "@playwright/test";
import { pageApi, personFromKey, readState, signInThroughUi } from "./shared";

type Thread = { messages: { kind: string; text?: string; name?: string; result?: { refused?: boolean } }[] };
type Tasks = { tasks: { id: string; agentId: string; instructions: string; status: string; engine: string }[] };

test("agent chat: a real turn streams its steps, a refused payment shows its card, @Grok Bot starts a background job", async ({ page }) => {
  const s = readState();
  const owner = personFromKey("owner", s.ownerKey);
  await signInThroughUi(page, owner.account);

  // the Clerk is in the sidebar and opens its conversation
  await page.getByText("Clerk", { exact: true }).first().click();
  await page.waitForURL(`**/chat?agent=${s.agent}`);
  const box = page.getByPlaceholder("Message Clerk");
  await expect(box).toBeVisible();

  // 1. a real turn: the question shows at once, the agent's steps stream in, then its answer; the server has both
  const ask = `What is the treasury balance right now? One short sentence. (${Date.now()})`;
  await box.fill(ask);
  await box.press("Enter");
  await expect(page.getByText(ask)).toBeVisible();
  await expect(page.getByText("Checked the balances").first()).toBeAttached({ timeout: 90_000 });
  await expect(box).toBeEditable();
  await expect
    .poll(async () => {
      const t = await pageApi<Thread>(page, "GET", `/agents/${s.agent}/thread`);
      const i = t.json.messages.findIndex((m) => m.kind === "user" && m.text === ask);
      return i >= 0 && t.json.messages.slice(i).some((m) => m.kind === "assistant" && (m.text ?? "").length > 0);
    }, { timeout: 120_000 })
    .toBe(true);
  await expect(page.getByText(/USDC|\$/).last()).toBeVisible();

  // 2. a payment the rules refuse (not a saved payee): the red card says nothing was signed
  await box.fill("Use propose_payment now to draft $0.05 to 0x000000000000000000000000000000000000dEaD, memo 'browser test'. Call the tool even if you expect a refusal, then tell me what happened.");
  await box.press("Enter");
  await expect(page.getByText("Refused · nothing was signed").last()).toBeVisible({ timeout: 120_000 });
  const t2 = await pageApi<Thread>(page, "GET", `/agents/${s.agent}/thread`);
  expect(t2.json.messages.some((m) => m.kind === "tool" && m.name === "propose_payment" && m.result?.refused)).toBe(true);

  // 3. @Grok Bot (from the team list in the @ menu) hands a job to the agent's background run
  await expect(box).toBeEditable();
  await box.pressSequentially("@Gro", { delay: 60 });
  await page.getByRole("option", { name: /Grok Bot/ }).click();
  const job = `check the treasury balance in the background ${Date.now()}`;
  await box.pressSequentially(job);
  // the box takes typing while the last turn finishes, but sends only once the agent is free
  await expect(page.getByRole("button", { name: "Send" })).toHaveAttribute("aria-disabled", "false", { timeout: 120_000 });
  await box.press("Enter");
  const task = await expect
    .poll(async () => {
      const r = await pageApi<Tasks>(page, "GET", `/workspaces/${s.ws}/tasks`);
      return r.json.tasks.find((x) => x.agentId === s.agent && x.instructions.includes(job))?.status ?? null;
    }, { timeout: 30_000 })
    .not.toBeNull();
  void task;
  await expect(page.getByText(new RegExp(`${job.slice(0, 30)}`)).first()).toBeVisible({ timeout: 30_000 });
});
