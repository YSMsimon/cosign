/**
 * What the browser specs share: the throwaway workspace global-setup made (its owner's throwaway key lives in
 * node_modules/.cosign-tmp, never in the repo), API calls as a person, and signing in through the real sign-in page.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { api, type Person } from "../e2e/helpers";
import { injectWallet } from "./wallet";

export const STATE_FILE = "node_modules/.cosign-tmp/browser-state.json";
export type State = { ownerKey: `0x${string}`; ws: string; treasury: string; agent: string; agentName: string; lena: string; createdAt: string; extra?: Record<string, string> };

export function readState(): State {
  if (!existsSync(STATE_FILE)) throw new Error("no browser test workspace yet: global-setup didn't run");
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
}
export function writeState(s: State) {
  mkdirSync("node_modules/.cosign-tmp", { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

export function personFromKey(name: string, key: `0x${string}`): Person {
  const account = privateKeyToAccount(key);
  return { name, account, address: account.address.toLowerCase() };
}

/** Sign in the way a person does: open /sign-in, pick the (test) wallet, sign the message. Lands on /chat. */
export async function signInThroughUi(page: Page, account: PrivateKeyAccount, o: { from?: string } = {}) {
  const log = await injectWallet(page, account);
  await page.goto(o.from ?? "/sign-in");
  if (o.from) await page.waitForURL("**/sign-in"); // signed out, the app sends you to sign in
  await expect(page.getByText("Found 1 wallet in this browser")).toBeVisible();
  await page.getByRole("button", { name: /Test Wallet/ }).click();
  await expect(page.getByText(`Sign in as ${account.address.slice(0, 6)}…${account.address.slice(-4)}`)).toBeVisible();
  await page.getByRole("button", { name: "Sign message" }).click();
  await page.waitForURL("**/chat**");
  return log;
}

/** The same API, called from inside the page (with its session cookie): proves what the UI did is real. */
export async function pageApi<T = unknown>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(`/api/v1${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      return { status: r.status, json: (text ? JSON.parse(text) : null) as T };
    },
    { method, path, body },
  );
}

export { api };
