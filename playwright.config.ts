/**
 * Browser end-to-end tests (pnpm test:browser) against the running dev server (pnpm dev), in the system's Google Chrome
 * with a clean profile. Each spec signs in with a throwaway wallet the test injects (tests/browser/wallet.ts); the
 * workspace they share is created once by global-setup.ts on Arc testnet.
 */
import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// the same secrets the app and the API tests use (Circle, to fund the throwaway wallets); read, never printed
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export default defineConfig({
  testDir: "tests/browser",
  timeout: 240_000,
  expect: { timeout: 45_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  globalSetup: "./tests/browser/global-setup.ts",
  use: {
    baseURL: process.env.APP_URL ?? "http://localhost:3000",
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    // voice: a fake microphone that plays a spoken WAV, and no permission prompt
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  },
});
