import { expect, test, type Page } from "@playwright/test";
import { generatePrivateKey } from "viem/accounts";
import { api, signIn } from "../e2e/helpers";
import { pageApi, personFromKey, readState, signInThroughUi } from "./shared";

type Lines = { lines: { authorKind: string; authorId: string | null; text?: string }[] };
type Thread = { messages: { kind: string; text?: string }[] };

/** Type a message in the open room (with "@" + a pick from the list when `who` is given) and send it. */
async function say(page: Page, room: string, text: string, who?: string) {
  const box = page.getByPlaceholder(new RegExp(`^Message ${room}`));
  await expect(box).toBeEditable({ timeout: 120_000 });
  await box.click();
  if (who) {
    await box.pressSequentially(`@${who.slice(0, 3)}`, { delay: 60 });
    await page.getByRole("option", { name: new RegExp(who) }).click({ timeout: 20_000 });
  }
  await box.pressSequentially(text);
  await expect(page.getByRole("button", { name: "Send" })).toHaveAttribute("aria-disabled", "false", { timeout: 120_000 });
  await box.press("Enter");
}

test("Shared rooms: one room, two people's windows, the same messages; an agent's answer shows in both; none of it in one-to-one chats", async ({ browser }) => {
  test.setTimeout(360_000);
  const s = readState();
  const owner = personFromKey("owner", s.ownerKey);
  const emma = personFromKey("emma", generatePrivateKey());
  const tag = Date.now().toString(36);
  const name = `pay-${tag}`;

  // Emma joins the company as an Agent user (asks agents, can't approve)
  await signIn(owner);
  const roles = (await api(owner, "GET", `/workspaces/${s.ws}/roles`)).json.roles as { id: string; name: string }[];
  const invited = await api(owner, "POST", `/workspaces/${s.ws}/members`, { address: emma.address, roleId: roles.find((r) => r.name === "Agent user")!.id, title: `Emma ${tag}` });
  expect(invited.status, JSON.stringify(invited.json)).toBe(201);

  const you = await (await browser.newContext()).newPage();
  const her = await (await browser.newContext()).newPage();
  await signInThroughUi(you, owner.account);
  await signInThroughUi(her, emma.account);

  // 1. you make a public room with Emma and the agent in it
  await you.getByRole("button", { name: "New" }).click();
  await you.getByRole("menuitem", { name: "New room" }).click();
  await you.getByRole("radio", { name: "Public room" }).click();
  await you.getByRole("button", { name: "Next" }).click();
  await you.getByLabel("Room name").fill(name);
  await you.getByLabel("Guidelines").fill("Bills and payments.");
  await you.getByRole("button", { name: "Next" }).click();
  await you.getByRole("checkbox", { name: `Invite ${s.agentName}` }).click();
  await you.getByRole("checkbox", { name: `Invite Emma ${tag}` }).click();
  await you.getByRole("button", { name: "Create" }).click();
  await you.waitForURL(/room=room_/);
  const roomId = new URL(you.url()).searchParams.get("room")!;

  // 2. it is in Emma's window too (her own browser, her own sign-in): the same room, from the server
  await her.goto(`/chat?room=${roomId}`);
  await expect(her.getByText(name).first()).toBeVisible({ timeout: 30_000 });

  // 3. Emma writes; it shows in your window within a few seconds
  await say(her, name, `hello from Emma ${tag}`);
  await expect(you.getByText(`hello from Emma ${tag}`)).toBeVisible({ timeout: 20_000 });

  // 4. you ask the agent in the room: its answer shows in your window as it works, then in Emma's
  await say(you, name, ` reply with only the words shared room ${tag}`, s.agentName);
  const mine = you.locator('[data-slot="message"]').filter({ hasText: `shared room ${tag}` }).last();
  await expect(mine.locator('[data-slot="message-header"]')).toHaveText(new RegExp(`^${s.agentName}`), { timeout: 120_000 });
  const hers = her.locator('[data-slot="message"]').filter({ hasText: `shared room ${tag}` });
  await expect(hers.last().locator('[data-slot="message-header"]')).toHaveText(new RegExp(`^${s.agentName}`), { timeout: 30_000 });

  // the server has one copy of each message, in order
  const lines = (await pageApi<Lines>(her, "GET", `/workspaces/${s.ws}/rooms/${roomId}/lines`)).json.lines;
  expect(lines.map((l) => l.authorKind)).toEqual(["member", "member", "agent"]);
  expect(lines[2].authorId).toBe(s.agent);

  // 5. nothing said in the room lands in your one-to-one chat with the agent
  const thread = await pageApi<Thread>(you, "GET", `/agents/${s.agent}/thread`);
  expect(thread.json.messages.some((m) => (m.text ?? "").includes(`shared room ${tag}`))).toBe(false);

  // tidy: the room goes (only its maker may delete it)
  expect((await pageApi(her, "DELETE", `/workspaces/${s.ws}/rooms/${roomId}`)).status).toBe(403);
  expect((await pageApi(you, "DELETE", `/workspaces/${s.ws}/rooms/${roomId}`)).status).toBe(200);
});
