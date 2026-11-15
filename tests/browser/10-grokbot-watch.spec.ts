import { expect, test } from "@playwright/test";
import { api, send, signIn, startMockBot, type PreparedTx } from "../e2e/helpers";
import { pageApi, personFromKey, readState, signInThroughUi } from "./shared";

type Proposals = { proposals: { id: number; memo: string; status: string }[] };
type Tasks = { tasks: { id: string; agentId: string; source: string; engine: string; status: string; instructions: string; result: string | null }[] };

/**
 * Grok Bot watches the chain: a treasury payment executes onchain, the activity feed picks it up (the QuickNode Stream,
 * or the Arc fallback while it's paused), a Grok Bot job starts by itself to check it, and the agent's chat shows the
 * onchain event and Grok Bot's answer. The routine is a stand-in that behaves like the real webhook routine.
 */
test("Grok Bot watches the chain: a payment executes, Grok Bot is asked to check it, and its answer shows in the chat", async ({ page }) => {
  test.setTimeout(300_000);
  const s = readState();
  const owner = personFromKey("owner", s.ownerKey);
  const tag = Date.now();
  await signIn(owner);
  const KEY = "browser-mock-webhook-key-watch-1";
  const bot = startMockBot(4567, KEY);
  try {
    const c = await api(owner, "POST", `/agents/${s.agent}/grokbot`, { webhookUrl: bot.url, webhookKey: KEY, waitMs: 15_000 });
    expect(c.status, JSON.stringify(c.json)).toBe(200);

    // 1. the agent drafts one cent to Lena (a real chat turn), and the owner cosigns it from their wallet: it pays
    const turn = await fetch(`${process.env.APP_URL ?? "http://localhost:3000"}/api/v1/agents/${s.agent}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner.cookie! },
      body: JSON.stringify({ message: `Draft a $0.01 treasury payment to Lena (${s.lena}) with memo 'watch ${tag}'. Use propose_payment.` }),
    });
    await turn.text();
    const proposal = (await api(owner, "GET", `/workspaces/${s.ws}/proposals?status=all`)).json as Proposals;
    const p = proposal.proposals.find((x) => x.memo.includes(`watch ${tag}`));
    expect(p, "the agent drafted the payment").toBeTruthy();
    const { tx } = (await api(owner, "GET", `/workspaces/${s.ws}/proposals/${p!.id}/cosign`)).json as { tx: PreparedTx };
    await send(owner, tx);

    // 2. the feed sees the payment and Grok Bot is asked to check it (source "watch"), on its routine
    let job: Tasks["tasks"][number] | undefined;
    await expect
      .poll(
        async () => {
          await api(owner, "GET", `/workspaces/${s.ws}/activity?limit=20`); // the Arc fallback reads new blocks
          const t = (await api(owner, "GET", `/workspaces/${s.ws}/tasks`)).json as Tasks;
          job = t.tasks.find((x) => x.source === "watch" && x.instructions.includes(`paid proposal #${p!.id}:`));
          return job?.status ?? null;
        },
        { timeout: 180_000, intervals: [3000] },
      )
      .toBe("done");
    expect(job!.engine).toBe("grokbot");
    expect(job!.agentId).toBe(s.agent);

    // 3. the chat shows the onchain event and Grok Bot's turn with its answer
    await signInThroughUi(page, owner.account);
    await page.goto(`/chat?agent=${s.agent}`);
    const line = page.getByText(new RegExp(`Onchain · paid proposal #${p!.id}: \\$0\\.01`)).last();
    await expect(line).toBeVisible({ timeout: 60_000 });
    const grok = page.locator('[data-slot="message"]').filter({ hasText: "Finished in the background · checking it" }).last();
    await expect(grok.locator('[data-slot="message-header"]')).toHaveText(/^Grok Bot\s*Background$/);
    await expect(grok.getByText(job!.result ?? "context").first()).toBeVisible();
    const tasks = (await pageApi<Tasks>(page, "GET", `/workspaces/${s.ws}/tasks`)).json.tasks;
    expect(tasks.filter((x) => x.source === "watch" && x.instructions.includes(`paid proposal #${p!.id}:`))).toHaveLength(1); // one job per event
  } finally {
    await api(owner, "DELETE", `/agents/${s.agent}/grokbot`);
    await bot.close();
  }
});
