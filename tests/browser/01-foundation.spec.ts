import { expect, test } from "@playwright/test";
import { pageApi, personFromKey, readState, signInThroughUi } from "./shared";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

test("foundation: wallet sign-in, your workspace and account, the live feed, sign out", async ({ page }) => {
  const s = readState();
  const owner = personFromKey("owner", s.ownerKey);

  // the live feed opens as soon as the app is signed in
  const stream = page.waitForRequest((r) => r.url().includes(`/workspaces/${s.ws}/activity/stream`));
  await signInThroughUi(page, owner.account, { from: "/chat" });

  // the workspace and the person, from the API
  await expect(page.getByText("Browser Co", { exact: true })).toBeVisible();
  const me = await pageApi<{ address: string; workspaces: { id: string }[] }>(page, "GET", "/me");
  expect(me.status).toBe(200);
  expect(me.json.address).toBe(owner.address);
  expect(me.json.workspaces.map((w) => w.id)).toContain(s.ws);
  await stream;

  // the account menu: name (their title), address, wallet, network
  await page.getByRole("button", { name: "Your wallet" }).click();
  await expect(page.getByText(`${short(owner.address)} · Test Wallet`)).toBeVisible();
  await expect(page.getByRole("menu").getByText("Founder", { exact: true })).toBeVisible();
  await expect(page.getByText("Arc testnet")).toBeVisible();

  // sign out: back to the sign-in page, and the session is gone on the server too
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL("**/sign-in");
  expect((await pageApi(page, "GET", "/me")).status).toBe(401);
});
