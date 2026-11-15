import { test } from "@playwright/test";
import { personFromKey, readState, signInThroughUi } from "./shared";

// a scratch spec for looking at a page (skipped unless DEBUG_PAGE is set): prints console errors and the visible text
test("debug page", async ({ page }) => {
  test.skip(!process.env.DEBUG_PAGE, "set DEBUG_PAGE=/path to use");
  const s = readState();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 400)));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 400)}`));
  await signInThroughUi(page, personFromKey("owner", s.ownerKey).account);
  await page.goto(process.env.DEBUG_PAGE!.replace("{agent}", s.agent).replace("{ws}", s.ws));
  await page.waitForTimeout(Number(process.env.DEBUG_WAIT ?? 6000));
  console.log("URL", page.url());
  console.log("ERRORS\n" + errors.join("\n"));
  console.log("TEXT\n" + (await page.locator("body").innerText()).slice(0, 3000));
  await page.screenshot({ path: "test-results/debug.png", fullPage: false });
});
