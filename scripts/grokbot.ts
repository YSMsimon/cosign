/**
 * Connect a Grok Bot routine to a demo agent and send it tasks, from the terminal (no frontend, no
 * wallet sign-in: this acts as the Test CFO, the All access member of the demo workspace).
 *
 *   pnpm grokbot setup [agent]                copy the setup message to paste into one Bot's own chat
 *   pnpm grokbot connect [agent]              read the Webhook URL, then the Key, from your clipboard; ping; wait for the ack
 *   pnpm grokbot status [agent]               connection state and the last tasks
 *   pnpm grokbot task [agent] "instructions"  send one task to the Bot and follow its progress
 *   pnpm grokbot disconnect [agent]
 *
 * [agent] is an agent name in the demo workspace (default: Clerk). Needs `pnpm dev` running and a
 * public URL for it: PUBLIC_BASE_URL in .env.local, or a running ngrok tunnel (found automatically).
 * GROKBOT_WEBHOOK_HEADER=<name> sends the key in only that header (default: Authorization and X-Webhook-Key).
 */
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { and, desc, eq } from "drizzle-orm";
import { wallet } from "../src/lib/arc";
import { db, schema } from "../src/lib/db";
import { loadMembership } from "../src/lib/server/access";
import { connect, connectionOf, disconnect, setupMessage, startTask } from "../src/lib/server/grokbot";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clip = () => execFileSync("pbpaste", { encoding: "utf8" }).trim();

async function publicBase(): Promise<string> {
  const env = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (env) return env;
  try {
    const r = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(2000) });
    const t = ((await r.json()) as { tunnels: { public_url: string }[] }).tunnels.find((x) => x.public_url.startsWith("https://"));
    if (t) return t.public_url;
  } catch {}
  throw new Error("no public URL: start `ngrok http 3000` or set PUBLIC_BASE_URL in .env.local");
}

async function checkReachable(base: string) {
  const r = await fetch(`${base}/api/v1/auth/nonce`, { headers: { "user-agent": "curl/8" }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!r?.ok) throw new Error(`${base} does not reach the app (is \`pnpm dev\` running and the tunnel pointing at :3000?)`);
}

function demo(agentName: string) {
  const ws = db().select().from(schema.workspaces).where(eq(schema.workspaces.name, "Nova Labs")).get();
  if (!ws) throw new Error("no demo workspace: run pnpm tsx --env-file=.env.local scripts/seed-demo.ts");
  const m = loadMembership(wallet("test-cfo").address.toLowerCase(), ws.id);
  if (!m) throw new Error("the Test CFO is not a member of the demo workspace");
  const agents = db().select().from(schema.agents).where(and(eq(schema.agents.workspaceId, ws.id), eq(schema.agents.status, "active"))).all();
  const agent = agents.find((a) => a.name.toLowerCase() === agentName.toLowerCase());
  if (!agent) throw new Error(`no agent "${agentName}" in ${ws.name}; there are: ${agents.map((a) => a.name).join(", ")}`);
  return { m, ws, agent };
}

async function follow(taskId: string, minutes = 10) {
  let seen = 0;
  let status = "";
  const t0 = Date.now();
  while (Date.now() - t0 < minutes * 60_000) {
    const t = db().select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get()!;
    if (t.status !== status) console.log(`  [${t.status}]`);
    status = t.status;
    const progress = JSON.parse(t.progress) as { t: string; message: string }[];
    for (const p of progress.slice(seen)) console.log(`  · ${p.message}`);
    seen = progress.length;
    if (t.status === "done") return console.log(`\nresult:\n${t.result}`);
    if (t.status === "failed") return console.log(`\nfailed: ${t.error}`);
    await sleep(2000);
  }
  console.log(`still ${status} after ${minutes} min; check later with: pnpm grokbot status`);
}

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
