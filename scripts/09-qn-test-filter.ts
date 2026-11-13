/**
 * Run the Cosign filters on QuickNode's own servers (POST /streams/test_filter) against real
 * Arc testnet blocks, and compare with a local run of the same filter on the same blocks.
 * Tests both variants:
 *   embedded — addresses baked into the filter source
 *   kv       — addresses in QuickNode Key-Value Store lists (synced first), read via qnLib
 * Run: pnpm tsx --env-file=.env.local scripts/09-qn-test-filter.ts
 */
import { buildFilterSource, buildKvFilterSource, runFilterLocally } from "../src/lib/quicknode/filter";
import { LIST_TREASURIES, LIST_WALLETS, syncList } from "../src/lib/quicknode/kv";
import { currentWatchlist } from "../src/lib/quicknode/watchlist";

const QN = "https://api.quicknode.com/streams/rest/v1/streams";
const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.io";
const BLOCKS = [72148041, 72148045, 72148058, 72148072, 72154023, 72157444];

type Ev = { transactionHash: string; logIndex: string | number };

async function rpcLogs(block: number): Promise<unknown[]> {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ fromBlock: `0x${block.toString(16)}`, toBlock: `0x${block.toString(16)}` }] }) });
    const j = (await r.json().catch(() => ({}))) as { result?: unknown[] };
    if (Array.isArray(j.result)) return j.result;
    await new Promise((res) => setTimeout(res, 500 * 2 ** i));
  }
  throw new Error(`eth_getLogs ${block} failed`);
}

async function remoteRun(source: string, block: number) {
  let res: Response;
  for (let i = 0; ; i++) {
    res = await fetch(`${QN}/test_filter`, {
      method: "POST",
      headers: { "x-api-key": process.env.QUICKNODE_API_KEY!, "content-type": "application/json" },
      body: JSON.stringify({ network: "arc-testnet", dataset: "logs", filter_function: Buffer.from(source).toString("base64"), block: String(block) }),
    });
    if (res.status !== 429 || i >= 6) break;
    await new Promise((r) => setTimeout(r, 2000 * 2 ** i)); // QuickNode REST rate limit
  }
  const j = (await res.json()) as { result?: unknown; logs?: unknown[] };
  if (!res.ok) throw new Error(`test_filter ${block}: HTTP ${res.status} ${JSON.stringify(j).slice(0, 300)}`);
  const parsed = typeof j.result === "string" ? JSON.parse(j.result || "null") : j.result;
  return { out: parsed as { events?: Ev[] } | null, logs: j.logs };
}

(async () => {
  const w = currentWatchlist();
  // 1. the KV lists the stream filter reads (wallet list also includes treasuries: USDC deposits into a treasury)
  const s1 = await syncList(LIST_TREASURIES, w.treasuries);
  const s2 = await syncList(LIST_WALLETS, [...w.wallets, ...w.treasuries]);
  console.log(`KV lists: ${JSON.stringify(s1)} ${JSON.stringify(s2)}`);
  const lists = { [LIST_TREASURIES]: w.treasuries, [LIST_WALLETS]: [...w.wallets, ...w.treasuries] };

  const variants = {
    embedded: buildFilterSource(w),
    kv: buildKvFilterSource({ factory: w.factory, listTreasuries: LIST_TREASURIES, listWallets: LIST_WALLETS }),
  };
  const key = (e: Ev) => `${e.transactionHash}:${Number(e.logIndex)}`;
  let allMatch = true;
  for (const block of BLOCKS) {
    const logs = await rpcLogs(block);
    const row: string[] = [];
    let ref: string | null = null;
    for (const [name, source] of Object.entries(variants)) {
      const remote = await remoteRun(source, block);
      const local = (await runFilterLocally(source, [logs], lists)) as { events?: Ev[] } | null;
      const r = JSON.stringify((remote.out?.events ?? []).map(key).sort());
      const l = JSON.stringify((local?.events ?? []).map(key).sort());
      ref ??= l;
      const same = r === l && l === ref;
      allMatch &&= same;
      row.push(`${name}: QN ${remote.out?.events?.length ?? 0} / local ${local?.events?.length ?? 0} ${same ? "MATCH" : "DIFFERENT"}${remote.logs?.length ? ` (filter logs: ${JSON.stringify(remote.logs).slice(0, 100)})` : ""}`);
    }
    console.log(`block ${block} (${logs.length} logs) → ${row.join(" | ")}`);
  }
  console.log(allMatch ? "\nAll blocks match: both filters behave the same on QuickNode as locally." : "\nMismatch found — see above.");
})().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
});
