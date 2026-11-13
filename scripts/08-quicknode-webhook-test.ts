/**
 * Step 1 test (no QuickNode credits): real Arc testnet blocks → our Streams filter (run locally,
 * exactly as QuickNode would) → signed webhook delivery → decode → SQLite → feed (+ live SSE).
 * Checks: unrelated logs are filtered out, duplicate USDC logs are ignored, bad/stale signatures
 * are rejected, redelivery inserts nothing new, and the SSE feed pushes new activity live.
 * Needs `pnpm dev`. Run: pnpm tsx --env-file=.env.local scripts/08-quicknode-webhook-test.ts
 */
import { randomBytes } from "node:crypto";
import { buildFilterSource, runFilterLocally } from "../src/lib/quicknode/filter";
import { signQuickNode } from "../src/lib/quicknode/verify";
import { currentWatchlist } from "../src/lib/quicknode/watchlist";

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.io";
const APP = process.env.APP_URL ?? "http://localhost:3000";
const SECRET = process.env.QUICKNODE_STREAM_SECURITY_TOKEN!;

// our real demo transactions (treasury flow, agent proposal, transfers, x402, Gateway deposit)
const TXS = [
  "0x9a06d819dd77cbfe8fb79a46fa6702edc8f447a1438199614fd1530e5fcef0de",
  "0xfe8f725c04209dc6fb577acac605c21f6c382289892fc2cdd071aec985216180",
  "0x399ec2fcdbba1c85b47b51bac0531f128a1352c2e008d1a50d0ce99db5df8a16",
  "0x53d83744bbfeb6152e19944706401c0f240d7419dc72650ad7b08d6d14308529",
  "0xb9256ca8ff0a25ecd34373b92fab6ebb0c8e5a993b11128a4ff1f772cf69995d",
  "0xd3294d0f20344d37c4c36087cc92b9ec9320b0534c4ec3224316cc90a36fdd6c",
  "0x4e410b4cd5325f718f87f5ce1472ecd6756c9a702ffc8d2b7ee22280cfa0b2e5",
  "0x46ddf052dffa839b895bc865166494f1db9ac6bceddc7a42e5bed55f368fd44f",
  "0xddd7cc5f58a603f4902d3f8f92648c75db754e40b578b8b3d90185e9c3871712",
  "0x3e60211bbebea0a683bb0063dcc9da69bf457c4254b5e39acc706d049d6b04d7",
];

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  // public RPC rate-limits: retry with backoff and never return a partial/empty result silently
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = (await r.json().catch(() => ({}))) as { result?: T; error?: { code?: number; message?: string } };
    if (j.result !== undefined && j.result !== null) return j.result;
    await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
  }
  throw new Error(`${method} failed after retries`);
}

async function deliver(payload: unknown, opts: { badSig?: boolean; staleTs?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const nonce = randomBytes(16).toString("hex");
  const ts = String(Math.floor(Date.now() / 1000) - (opts.staleTs ? 3600 : 0));
  const sig = opts.badSig ? "00".repeat(32) : signQuickNode(SECRET, nonce, ts, body);
  const r = await fetch(`${APP}/api/webhooks/quicknode`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-qn-nonce": nonce, "x-qn-timestamp": ts, "x-qn-signature": sig },
    body,
  });
  return { status: r.status, json: await r.json() };
}

(async () => {
  if (!SECRET) throw new Error("set QUICKNODE_STREAM_SECURITY_TOKEN in .env.local");

  // 1. full logs of every block that contains one of our transactions (includes strangers' logs)
  const blocks = new Set<string>();
  for (const tx of TXS) blocks.add((await rpc<{ blockNumber: string }>("eth_getTransactionReceipt", [tx])).blockNumber);
  const streamData: unknown[] = [];
  let totalLogs = 0;
  for (const b of [...blocks].sort()) {
    const logs = await rpc<unknown[]>("eth_getLogs", [{ fromBlock: b, toBlock: b }]);
    totalLogs += logs.length;
    streamData.push(logs);
  }

  // 2. run the exact filter source QuickNode will run
  const source = buildFilterSource(currentWatchlist());
  const out = (await runFilterLocally(source, streamData)) as { events: unknown[] } | null;
  console.log(`1. ${blocks.size} real blocks, ${totalLogs} logs in total → filter kept ${out?.events.length ?? 0} (strangers' logs and duplicate 0x3600 Transfers dropped)`);

  // 3. open the live feed before delivering
  const ac = new AbortController();
  const sse = await fetch(`${APP}/api/activity/stream`, { signal: ac.signal });
  const reader = sse.body!.getReader();
  const pushed: string[] = [];
  const pump = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (const chunk of buf.split("\n\n").slice(0, -1)) if (chunk.startsWith("event: activity")) pushed.push(chunk);
        buf = buf.split("\n\n").pop() ?? "";
      }
    } catch {}
  })();

  // 4. signature checks
  const bad = await deliver(out, { badSig: true });
  const stale = await deliver(out, { staleTs: true });
  console.log(`2. bad signature → HTTP ${bad.status} (${bad.json.error}); stale timestamp → HTTP ${stale.status} (${stale.json.error})`);

  // 5. real delivery, then redelivery
  const first = await deliver(out);
  const again = await deliver(out);
  console.log(`3. delivery → HTTP ${first.status} ${JSON.stringify(first.json)}`);
  console.log(`   redelivery → HTTP ${again.status} inserted ${again.json.inserted} (deduped on tx + log index)`);

  await new Promise((r) => setTimeout(r, 800));
  console.log(`4. live SSE feed pushed ${pushed.length} activity events while delivering`);
  ac.abort();
  await pump;

  // 6. the feed endpoint
  const feed = (await (await fetch(`${APP}/api/activity?limit=30`)).json()) as { activity: { blockNumber: number; type: string; summary: string }[] };
  console.log(`5. GET /api/activity → ${feed.activity.length} rows (newest first):`);
  for (const a of feed.activity) console.log(`   [${a.blockNumber}] ${a.type.padEnd(18)} ${a.summary}`);
})().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
});
