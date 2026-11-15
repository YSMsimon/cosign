import { expect, test, type Page } from "@playwright/test";
import { pageApi, personFromKey, readState, signInThroughUi } from "./shared";

type Approvals = { approvals: { id: string; status: string; url: string; amountUsd: string }[] };
type Proposals = { proposals: { id: number; status: string; amountUsd: string | null; memo: string; to: string }[] };

async function ask(page: Page, text: string) {
  const box = page.getByPlaceholder("Message Clerk");
  await expect(box).toBeEditable({ timeout: 120_000 });
  await box.fill(text);
  // the box takes typing while a turn runs, but sends only once the agent is free
  await expect(page.getByRole("button", { name: "Send" })).toHaveAttribute("aria-disabled", "false", { timeout: 120_000 });
  await box.press("Enter");
}

/** The id of the proposal whose memo has `memo`, once the agent's draft is onchain. */
async function proposalWith(page: Page, ws: string, memo: string) {
  let id: number | undefined;
  await expect
    .poll(async () => {
      id = (await pageApi<Proposals>(page, "GET", `/workspaces/${ws}/proposals`)).json.proposals.find((p) => p.memo.includes(memo))?.id;
      return id ?? null;
    }, { timeout: 120_000 })
    .not.toBeNull();
  return id!;
}

test("treasury approval: OK a purchase over the line, cosign a drafted payment in the wallet, cancel another", async ({ page }) => {
  test.setTimeout(420_000);
  const s = readState();
  const owner = personFromKey("owner", s.ownerKey);
  const walletCalls = await signInThroughUi(page, owner.account);
  await page.goto(`/chat?agent=${s.agent}`);
  const lena = s.lena.slice(0, 6);

  // 1. a send over the Clerk's $0.01 ask-a-person line waits for a person; Approve tells it to try again, and it goes through
  const tag = Date.now();
  await ask(page, `Send $0.02 USDC from your own wallet to Lena (the saved payee ${s.lena}), memo 'browser approval ${tag}'. Use send_usdc.`);
  const purchase = page.getByRole("alert").filter({ hasText: `Let Clerk send $0.02 to ${lena}` }).last();
  await expect(purchase).toBeVisible({ timeout: 120_000 });
  await purchase.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("OK'd $0.02").last()).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => {
      const r = await pageApi<Approvals>(page, "GET", `/workspaces/${s.ws}/approvals?status=all`);
      return r.json.approvals.find((a) => a.url === `send:${s.lena}`)?.status ?? null;
    }, { timeout: 180_000, message: "the approved send is used by the agent's retry" })
    .toBe("used");

  // 2. a treasury payment it drafts: Approve signs the cosign in the (test) wallet; the payment executes onchain
  await ask(page, `Draft a $0.01 treasury payment to Lena (${s.lena}) with memo 'browser cosign ${tag}'. Use propose_payment.`);
  // the card for this draft, by its proposal number (an earlier run may have left another one open)
  const pid1 = await proposalWith(page, s.ws, `browser cosign ${tag}`);
  const pay = page.getByRole("alert").filter({ hasText: `Proposal #${pid1} · you sign in your own wallet` });
  await expect(pay).toBeVisible({ timeout: 120_000 });
  const sendsBefore = walletCalls.filter((c) => c.method === "eth_sendTransaction").length;
  const paid = page.getByText("Paid $0.01 to Lena", { exact: true });
  const paidBefore = await paid.count(); // earlier runs' paid cards are in this conversation too
  await pay.getByRole("button", { name: "Approve" }).click();
  await expect(paid).toHaveCount(paidBefore + 1, { timeout: 150_000 });
  expect(walletCalls.filter((c) => c.method === "eth_sendTransaction").length).toBe(sendsBefore + 1);
  const p1 = await pageApi<Proposals>(page, "GET", `/workspaces/${s.ws}/proposals`);
  expect(p1.json.proposals.find((p) => p.memo.includes(`browser cosign ${tag}`))?.status).toBe("executed");

  // 3. another draft, denied: the wallet signs the cancel; nothing is paid
  await ask(page, `Draft another $0.01 treasury payment to Lena (${s.lena}) with memo 'browser cancel ${tag}'. Use propose_payment.`);
  const pid2 = await proposalWith(page, s.ws, `browser cancel ${tag}`);
  const second = page.getByRole("alert").filter({ hasText: `Proposal #${pid2} · you sign in your own wallet` });
  await expect(second).toBeVisible({ timeout: 120_000 });
  const cancelled = page.getByText(/cancelled · nothing was paid/);
  const cancelledBefore = await cancelled.count();
  await second.getByRole("button", { name: "Deny" }).click();
  await expect(cancelled).toHaveCount(cancelledBefore + 1, { timeout: 150_000 });
  const p2 = await pageApi<Proposals>(page, "GET", `/workspaces/${s.ws}/proposals`);
  expect(p2.json.proposals.find((p) => p.memo.includes(`browser cancel ${tag}`))?.status).toBe("cancelled");
});
