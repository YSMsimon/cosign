import { expect, test } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { pageApi, personFromKey, readState, signInThroughUi } from "./shared";

type Members = { id: string; address: string; title: string | null; role: { name: string; key: string | null } }[];
type Agent = { agent: { controls: { purchases: { perPayment: number; daily: number }; allowedSellers: string[] } } };

test("permissions: invite a person and change their role; save an agent's limits, see a refusal, edit its sellers", async ({ page }) => {
  test.setTimeout(300_000);
  const s = readState();
  const owner = personFromKey("owner", s.ownerKey);
  await signInThroughUi(page, owner.account);
  await page.goto("/permissions");

  // People: you, with All access (locked switches)
  const me = page.getByRole("row").filter({ hasText: "Founder" });
  await expect(me.getByText("All access")).toBeVisible();
  await expect(me.getByRole("switch", { name: "Founder can approve" })).toBeDisabled();

  // invite a teammate as a Member: they show up invited, as an Agent user
  const mate = privateKeyToAccount(generatePrivateKey()).address;
  const name = `Alex ${Date.now() % 10000}`;
  await page.getByRole("button", { name: "Invite" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("textbox", { name: "Wallet address" }).fill(mate);
  await page.getByRole("dialog").getByRole("button", { name: "Invite" }).click();
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row.getByText("Agent user")).toBeVisible();
  await expect(row.getByText("invited")).toBeVisible();

  // Can approve → Approver (on the server too), and back
  await row.getByRole("switch", { name: `${name} can approve` }).click();
  await expect(row.getByText("Approver", { exact: true })).toBeVisible();
  let members = await pageApi<Members>(page, "GET", `/workspaces/${s.ws}/members`);
  expect(members.json.find((m) => m.address === mate.toLowerCase())?.role.key).toBe("approver");
  await row.getByRole("switch", { name: `${name} can approve` }).click();
  await expect(row.getByText("Agent user")).toBeVisible();
  members = await pageApi<Members>(page, "GET", `/workspaces/${s.ws}/members`);
  expect(members.json.find((m) => m.address === mate.toLowerCase())?.role.name).toBe("Agent user");

  // Agents → Clerk → Settings
  await page.getByRole("tab", { name: "Agents" }).click();
  await expect(page.getByText("What Clerk can do")).toBeVisible();
  const before = (await pageApi<Agent>(page, "GET", `/agents/${s.agent}`)).json.agent.controls;

  // a limit change is saved on the server
  const daily = before.purchases.daily === 0.6 ? 0.7 : 0.6;
  await page.getByRole("button", { name: "Change limits" }).first().click();
  await page.getByRole("dialog").getByLabel("Wallet, per day").fill(String(daily));
  await page.getByRole("button", { name: "Save change" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect.poll(async () => (await pageApi<Agent>(page, "GET", `/agents/${s.agent}`)).json.agent.controls.purchases.daily).toBe(daily);

  // a change the rules don't allow (per payment above per day) is refused, and the refusal shows
  await page.getByRole("button", { name: "Change limits" }).first().click();
  await page.getByRole("dialog").getByLabel("Wallet, per payment").fill("9");
  await page.getByRole("button", { name: "Save change" }).click();
  await expect(page.getByRole("dialog").getByText("The server said no")).toBeVisible();
  expect((await pageApi<Agent>(page, "GET", `/agents/${s.agent}`)).json.agent.controls.purchases.perPayment).toBe(before.purchases.perPayment);
  await page.getByRole("button", { name: "Cancel" }).click();

  // sellers it may pay: add one, then remove it
  const seller = "x402.quicknode.com";
  if (before.allowedSellers.includes(seller)) await pageApi(page, "PATCH", `/agents/${s.agent}`, { controls: { allowedSellers: before.allowedSellers.filter((x) => x !== seller) } });
  await page.reload();
  await page.getByRole("tab", { name: "Agents" }).click();
  await page.getByRole("button", { name: "Add seller" }).click();
  await page.getByRole("dialog").getByLabel("Seller host").fill(seller);
  await page.getByRole("dialog").getByRole("button", { name: "Add seller" }).click();
  await expect(page.getByText(seller, { exact: true })).toBeVisible();
  await expect.poll(async () => (await pageApi<Agent>(page, "GET", `/agents/${s.agent}`)).json.agent.controls.allowedSellers).toContain(seller);
  await page.getByRole("button", { name: `Remove ${seller}` }).click();
  await expect.poll(async () => (await pageApi<Agent>(page, "GET", `/agents/${s.agent}`)).json.agent.controls.allowedSellers).not.toContain(seller);

  // put the daily limit back
  await pageApi(page, "PATCH", `/agents/${s.agent}`, { controls: { purchases: { ...before.purchases } } });
});
