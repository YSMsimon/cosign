import { expect, test } from "@playwright/test";
import { signIn, sse } from "../e2e/helpers";
import { pageApi, personFromKey, readState, signInThroughUi } from "./shared";

type Ws = { treasury: { balanceUsd: string | number; approvers: string[] } };
type Proposals = { proposals: { id: number; status: string; memo: string }[] };
type Agent = { agent: { wallet: string } };
const usd = (n: number) => `$${n < 1 ? n.toFixed(2) : n % 1 ? n.toFixed(2) : n} USDC`;

test("treasury: real balance, approvers, onchain activity, ledger and wallets; an open proposal is approved from the ledger", async ({ page }) => {
  test.setTimeout(300_000);
  const s = readState();
  const owner = personFromKey("owner", s.ownerKey);

  // an open proposal to approve from the ledger: the Clerk drafts it (over the API, as the owner)
  await signIn(owner);
  const tag = `ledger ${Date.now()}`;
  const turn = await sse(owner, `/agents/${s.agent}/chat`, { message: `Draft a $0.01 treasury payment to Lena (${s.lena}) with memo '${tag}'. Use propose_payment.` });
  expect(turn.error, JSON.stringify(turn.error)).toBeFalsy();

  await signInThroughUi(page, owner.account);
  await page.goto("/permissions?tab=treasury");

  // the balance and approvers are the contract's
  const ws = (await pageApi<Ws>(page, "GET", `/workspaces/${s.ws}`)).json;
  await expect(page.getByText(usd(Number(ws.treasury.balanceUsd))).first()).toBeVisible();
  await expect(page.getByText(`1 of ${ws.treasury.approvers.length} must sign`)).toBeVisible();
  await expect(page.getByText("You", { exact: true })).toBeVisible();

  // the activity is read from Arc: earlier payments and drafts are there
  await expect(page.getByText(/Proposal #\d+ paid/).first()).toBeVisible();
  await expect(page.getByText(/Clerk drafted proposal #\d+/).first()).toBeVisible();

  // the wallets table: the treasury and the Clerk's own wallet
  const clerk = (await pageApi<Agent>(page, "GET", `/agents/${s.agent}`)).json.agent.wallet;
  await expect(page.getByText("Clerk's wallet")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Clerk's wallet" }).getByText(`${clerk.slice(0, 6)}…${clerk.slice(-4)}`)).toBeVisible();

  // the ledger: the open draft is approved in the (test) wallet and the row turns Paid
  const pid = (await pageApi<Proposals>(page, "GET", `/workspaces/${s.ws}/proposals`)).json.proposals.find((p) => p.memo === tag)!.id;
  const row = page.getByRole("row").filter({ hasText: `#${pid}` });
  await expect(row.getByText("Waiting")).toBeVisible();
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(row.getByText("Paid")).toBeVisible({ timeout: 150_000 });
  expect((await pageApi<Proposals>(page, "GET", `/workspaces/${s.ws}/proposals`)).json.proposals.find((p) => p.id === pid)?.status).toBe("executed");
});
