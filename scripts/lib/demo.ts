/**
 * Shared by the terminal tools (pnpm grokbot, pnpm voice): the public URL, a reachability check, and
 * the demo workspace with the Test CFO acting as its All access member.
 */
import { and, eq } from "drizzle-orm";
import { wallet } from "../../src/lib/arc";
import { db, schema } from "../../src/lib/db";
import { loadMembership } from "../../src/lib/server/access";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** PUBLIC_BASE_URL, or the https URL of a running ngrok tunnel. */
export async function publicBase(): Promise<string> {
  const env = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (env) return env;
  try {
    const r = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(2000) });
    const t = ((await r.json()) as { tunnels: { public_url: string }[] }).tunnels.find((x) => x.public_url.startsWith("https://"));
    if (t) return t.public_url;
  } catch {}
  throw new Error("no public URL: start `ngrok http 3000` or set PUBLIC_BASE_URL in .env.local");
}

export async function checkReachable(base: string) {
  const r = await fetch(`${base}/api/v1/auth/nonce`, { headers: { "user-agent": "curl/8" }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!r?.ok) throw new Error(`${base} does not reach the app (is \`pnpm dev\` running and the tunnel pointing at :3000?)`);
}

/** The "Nova Labs" demo workspace, the Test CFO's membership in it, and one of its active agents. */
export function demo(agentName: string) {
  const ws = db().select().from(schema.workspaces).where(eq(schema.workspaces.name, "Nova Labs")).get();
  if (!ws) throw new Error("no demo workspace: run pnpm tsx --env-file=.env.local scripts/seed-demo.ts");
  const m = loadMembership(wallet("test-cfo").address.toLowerCase(), ws.id);
  if (!m) throw new Error("the Test CFO is not a member of the demo workspace");
  const agents = db().select().from(schema.agents).where(and(eq(schema.agents.workspaceId, ws.id), eq(schema.agents.status, "active"))).all();
  const agent = agents.find((a) => a.name.toLowerCase() === agentName.toLowerCase());
  if (!agent) throw new Error(`no agent "${agentName}" in ${ws.name}; there are: ${agents.map((a) => a.name).join(", ")}`);
  return { m, ws, agent };
}

/** Print a task's status changes and progress lines until it finishes (or the time runs out). */
export async function follow(taskId: string, minutes = 10, o: { quietStatus?: boolean } = {}) {
  let seen = 0;
  let status = "";
  const t0 = Date.now();
  while (Date.now() - t0 < minutes * 60_000) {
    const t = db().select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get()!;
    if (t.status !== status && !o.quietStatus) console.log(`  [${t.status}]`);
    status = t.status;
    const progress = JSON.parse(t.progress) as { t: string; message: string }[];
    for (const p of progress.slice(seen)) console.log(`  · ${p.message}`);
    seen = progress.length;
    if (t.status === "done") return console.log(`\nresult:\n${t.result}`);
    if (t.status === "failed") return console.log(`\nfailed: ${t.error}`);
    await sleep(2000);
  }
  console.log(`still ${status} after ${minutes} min`);
}
