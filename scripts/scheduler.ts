/**
 * Local stand-in for Vercel Cron: calls POST /api/v1/cron/tick every minute so due schedules run.
 * Run (with pnpm dev up): pnpm tsx --env-file=.env.local scripts/scheduler.ts
 */
const APP = process.env.APP_URL ?? "http://localhost:3000";

async function tickOnce() {
  try {
    const r = await fetch(`${APP}/api/v1/cron/tick`, { method: "POST", headers: { "x-cron-secret": process.env.CRON_SECRET ?? "" } });
    const j = (await r.json()) as { ran?: { scheduleId: string; engine?: string; status: string; error?: string }[]; error?: string };
    if (!r.ok) return console.log(`${new Date().toISOString()} tick failed: HTTP ${r.status} ${j.error ?? ""}`);
    for (const x of j.ran ?? []) console.log(`${new Date().toISOString()} schedule ${x.scheduleId} → ${x.engine ?? "-"} ${x.status}${x.error ? ` (${x.error})` : ""}`);
  } catch (e) {
    console.log(`${new Date().toISOString()} tick error: ${(e as Error).message}`);
  }
}

console.log(`scheduler: ticking ${APP}/api/v1/cron/tick every 60 s (Ctrl-C to stop)`);
void tickOnce();
setInterval(tickOnce, 60_000);
