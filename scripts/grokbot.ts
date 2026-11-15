/**
 * Connect a Grok Bot routine to a demo agent and send it tasks, from the terminal (no frontend, no
 * wallet sign-in: this acts as the Test CFO, the All access member of the demo workspace).
 *
 *   pnpm grokbot setup [agent]                copy the setup message to paste into one Bot's own chat
 *   pnpm grokbot connect [agent]              read the Webhook URL, then the Key, from your clipboard; ping; wait for the ack
 *   pnpm grokbot status [agent]               connection state and the last tasks
 *   pnpm grokbot task [agent] "instructions"  send one task to the Bot and follow its progress
 *   pnpm grokbot disconnect [agent]
 *   pnpm grokbot mcp [agent]                  issue a connector token for Grok Bot → Add a custom MCP: prints the URL and
 *                                             copies the Authorization header value to the clipboard (never printed)
 *   pnpm grokbot mcp-check [agent]            self-test the MCP endpoint over the public URL with a throwaway token
 *
 * [agent] is an agent name in the demo workspace (default: Clerk). Needs `pnpm dev` running and a
 * public URL for it: PUBLIC_BASE_URL in .env.local, or a running ngrok tunnel (found automatically).
 * GROKBOT_WEBHOOK_HEADER=<name> sends the key in only that header (default: Authorization and X-Webhook-Key).
 */
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../src/lib/db";
import { connect, connectionOf, disconnect, setupMessage, startTask } from "../src/lib/server/grokbot";
import { issueMcpToken, revokeMcpTokens } from "../src/lib/server/mcp";
import { checkReachable, demo, follow, publicBase } from "./lib/demo";

const clip = () => execFileSync("pbpaste", { encoding: "utf8" }).trim();

(async () => {
  const [cmd = "status", ...rest] = process.argv.slice(2);
  const named = rest.length > 1 || (cmd !== "task" && rest.length === 1);
  const agentName = named ? rest[0] : "Clerk";
  const { m, ws, agent } = demo(agentName);

  if (cmd === "setup") {
    const base = await publicBase();
    const msg = setupMessage(agent, ws, base);
    execFileSync("pbcopy", { input: msg });
    console.log(`${msg}\n\n── copied to the clipboard (public URL ${base}). Paste it into ONE Bot's own chat in Grok Bot.`);
    return;
  }

  if (cmd === "mcp") {
    const base = await publicBase();
    const { token, expiresAt } = issueMcpToken(m, agent);
    execFileSync("pbcopy", { input: `Bearer ${token}` });
    console.log(`Grok Bot → Plugins → Add a custom MCP, for "${agent.name}":
  URL:                  ${base}/api/v1/mcp
  Authorization header: copied to your clipboard (Bearer …, never shown here); paste it as the header value
  Expires:              ${expiresAt} (issuing a new one revokes this one)`);
    return;
  }

  if (cmd === "mcp-check") {
    // a throwaway token, a few JSON-RPC calls over the public URL, then revoke: proves the endpoint end to end
    const base = await publicBase();
    const { token } = issueMcpToken(m, agent);
    const rpc = async (method: string, params: Record<string, unknown> = {}, id: number | null = 1) => {
      const r = await fetch(`${base}/api/v1/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "ngrok-skip-browser-warning": "1" },
        body: JSON.stringify(id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a JSON-RPC answer read loosely in a check script
      return { status: r.status, body: r.status === 202 ? null : ((await r.json()) as Record<string, any>) };
    };
    try {
      const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cosign-check", version: "1" } });
      console.log(`initialize  ${init.status}  protocol ${init.body?.result?.protocolVersion}  server "${init.body?.result?.serverInfo?.title}"`);
      const note = await rpc("notifications/initialized", {}, null);
      console.log(`initialized ${note.status} (notification, no body)`);
      const list = await rpc("tools/list", {}, 2);
      const names = (list.body?.result?.tools ?? []).map((t: { name: string }) => t.name);
      console.log(`tools/list  ${list.status}  ${names.length} tools: ${names.join(", ")}`);
      const team = await rpc("tools/call", { name: "list_team", arguments: {} }, 3);
      const teamOut = JSON.parse(team.body?.result?.content?.[0]?.text ?? "{}");
      console.log(`list_team   ${team.status}  isError=${team.body?.result?.isError}  people=${teamOut.people?.length} agents=${(teamOut.agents ?? []).map((a: { name: string }) => a.name).join(", ")}`);
      const bal = await rpc("tools/call", { name: "get_balances", arguments: {} }, 4);
      console.log(`get_balances ${bal.status} isError=${bal.body?.result?.isError}  ${String(bal.body?.result?.content?.[0]?.text ?? "").slice(0, 160)}`);
      const vm = await rpc("tools/call", { name: "sandbox_bash", arguments: { command: "id" } }, 5);
      console.log(`sandbox_bash ${vm.status} isError=${vm.body?.result?.isError}  ${String(vm.body?.result?.content?.[0]?.text ?? vm.body?.error?.message ?? "").slice(0, 120)}`);
      const bad = await fetch(`${base}/api/v1/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope", "ngrok-skip-browser-warning": "1" }, body: "{}" });
      console.log(`bad token   ${bad.status}  ${bad.headers.get("www-authenticate") ?? ""}`);
    } finally {
      revokeMcpTokens(m, agent);
      console.log("throwaway token revoked");
    }
    return;
  }

  if (cmd === "connect") {
    const base = await publicBase();
    await checkReachable(base);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("1. Copy the routine's Webhook URL in Grok Bot, then press Enter here.");
    const webhookUrl = clip();
    if (!/^https:\/\//.test(webhookUrl)) throw new Error("the clipboard does not hold an https URL; copy the Webhook URL and try again");
    console.log(`   Webhook URL: ${webhookUrl.replace(/\/\/([^/]+)\/.*/, "//$1/…")}`);
    await rl.question("2. Now copy the Key, then press Enter here (it is never shown).");
    const webhookKey = clip();
    rl.close();
    if (webhookKey === webhookUrl || /^https?:\/\//.test(webhookKey)) throw new Error("the clipboard still holds a URL, not the Key");
    console.log(`   Key: ${webhookKey.length} characters. Sending the ping via ${base} …`);
    console.log("   If Grok Bot shows an approval card for curl, approve it there. Waiting up to 3 minutes for the acknowledgement.");
    const r = await connect(m, agent, { webhookUrl, webhookKey }, base, 180_000);
    console.log(`\n${r.status.toUpperCase()}${"error" in r && r.error ? `: ${r.error}` : ""}${"note" in r && r.note ? `: ${r.note}` : ""}`);
    if (r.status === "failed" && /HTTP 40[13]/.test(String("error" in r ? r.error : ""))) {
      console.log(
        "Grok Bot refused the key. Open the routine's Webhook panel (right-click the routine → Webhook) and note the header name it lists,\nthen run: GROKBOT_WEBHOOK_HEADER=<that name> pnpm grokbot connect",
      );
    }
    return;
  }

  if (cmd === "task") {
    const instructions = named ? rest.slice(1).join(" ") : rest.join(" ");
    if (!instructions) throw new Error('usage: pnpm grokbot task [agent] "instructions"');
    const c = connectionOf(agent.id);
    if (c?.status !== "connected") throw new Error(`${agent.name} has no connected Grok Bot (status: ${c?.status ?? "not connected"}); run pnpm grokbot connect first`);
    const base = await publicBase();
    await checkReachable(base);
    const { task } = await startTask(agent, ws, { kind: "task", source: "member", instructions, requestedBy: m.member.id, base });
    console.log(`task ${task.id} → ${agent.name}'s Grok Bot`);
    if (task.status === "failed") return console.log(`failed: ${task.error}`);
    return follow(task.id);
  }

  if (cmd === "disconnect") {
    console.log(disconnect(m, agent));
    return;
  }

  const c = connectionOf(agent.id);
  console.log(`${agent.name} (${ws.name}): ${c ? `${c.status}${c.connectedAt ? ` since ${c.connectedAt}` : ""}${c.lastError ? ` · last error: ${c.lastError}` : ""}` : "not connected"}`);
  const tasks = db().select().from(schema.tasks).where(eq(schema.tasks.agentId, agent.id)).orderBy(desc(schema.tasks.createdAt)).limit(5).all();
  for (const t of tasks) console.log(`  ${t.createdAt}  ${t.kind.padEnd(4)}  ${t.status.padEnd(7)}  ${(t.error ?? t.result ?? t.instructions).replace(/\s+/g, " ").slice(0, 90)}`);
})().catch((e) => {
  console.error("FAILED:", e?.message ?? String(e));
  process.exit(1);
});
