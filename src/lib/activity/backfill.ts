/**
 * Read a treasury's history straight from Arc: its own events (drafts, cosigns, payments, cancels, petty cash,
 * approver changes) and the USDC that moved in or out of it. The QuickNode stream writes the same rows when it runs
 * (deduped on tx hash + log index); this covers the time it doesn't. Server-only.
 *
 * Arc's public RPC allows at most 10,000 blocks per log query and about one request a second, so this reads in the
 * background, one paced call at a time: new blocks first, then back in time to where the stored rows (or the
 * treasury's start) leave off. It keeps its place after every chunk, and after a refusal it waits and carries on.
 * Rows go into the activity store as each chunk is read, so open pages get them from the live stream.
 */
import { createPublicClient, http, pad, type Address } from "viem";
import { max, sql } from "drizzle-orm";
import { arcTestnet } from "../arc";
import { db, schema } from "../db";
import type { NewActivity } from "../db/schema";
import { ARC_SYSTEM_EMITTER, TRANSFER_TOPIC } from "../quicknode/filter";
import { addressBook, decodeStreamLog } from "./decode";
import { insertActivities } from "./store";

const CHUNK = 10_000n; // the public RPC's limit per getLogs
const FIRST_LOOK = 400_000n; // about 3 days of Arc blocks (≈124k a day): how far back a treasury's first read goes
const GAP_MS = 1_100; // between calls: the public RPC allows about one a second, shared with everything else
const EVERY_MS = 15_000; // look for new blocks at most this often per treasury
const BACKOFF_MS = 30_000; // after the RPC refuses, wait this long before reading again

// its own client: no automatic retries (a refusal pauses the read instead of adding calls)
const rpc = createPublicClient({ chain: arcTestnet, transport: http(undefined, { retryCount: 0, timeout: 20_000 }) });

/** What has been read for a treasury: blocks `bottom`..`top`, down to `floor` when done. */
type Sync = { top: bigint; bottom: bigint; floor: bigint; at: number; pausedUntil: number; running?: Promise<void> };
const g = globalThis as unknown as { __cosignLogSync2?: Map<string, Sync>; __cosignLogPace?: { last: number } };
const syncs = (g.__cosignLogSync2 ??= new Map());
const pace = (g.__cosignLogPace ??= { last: 0 });

/** One RPC call, spaced from the previous one (across every treasury). */
async function paced<T>(call: () => Promise<T>): Promise<T> {
  const wait = pace.last + GAP_MS - Date.now();
  pace.last = Date.now() + Math.max(wait, 0);
  if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
  return call();
}

type RawLog = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string };
const hex = (n: bigint) => `0x${n.toString(16)}` as const;
const range = (from: bigint, to: bigint) => ({ fromBlock: hex(from), toBlock: hex(to) });

/** The treasury's own logs, and USDC moving into and out of it (Arc's system emitter), in blocks from..to. */
async function logsIn(t: Address, from: bigint, to: bigint): Promise<RawLog[]> {
  const topic = pad(t);
  const own = (await paced(() => rpc.request({ method: "eth_getLogs", params: [{ address: t, ...range(from, to) }] }))) as RawLog[];
  const incoming = (await paced(() => rpc.request({ method: "eth_getLogs", params: [{ address: ARC_SYSTEM_EMITTER, topics: [TRANSFER_TOPIC, null, topic], ...range(from, to) }] }))) as RawLog[];
  const outgoing = (await paced(() => rpc.request({ method: "eth_getLogs", params: [{ address: ARC_SYSTEM_EMITTER, topics: [TRANSFER_TOPIC, topic], ...range(from, to) }] }))) as RawLog[];
  return [...own, ...incoming, ...outgoing];
}

/** Decode and store one chunk's logs (block times read once per block). */
async function storeChunk(t: Address, logs: RawLog[]) {
  if (!logs.length) return;
  const names = addressBook();
  const times = new Map<string, number>();
  const rows: NewActivity[] = [];
  for (const l of logs) {
    if (!times.has(l.blockNumber)) times.set(l.blockNumber, Number((await paced(() => rpc.getBlock({ blockNumber: BigInt(l.blockNumber) }))).timestamp));
    const row = decodeStreamLog(
      { address: l.address, topics: l.topics, data: l.data, blockNumber: Number(BigInt(l.blockNumber)), blockTimestamp: times.get(l.blockNumber)!, transactionHash: l.transactionHash, logIndex: Number(BigInt(l.logIndex)) },
      names,
    );
    // a USDC movement in or out belongs to this treasury's feed too
    if (row) rows.push({ ...row, treasury: row.treasury ?? t, source: "chain" });
  }
  if (rows.length) insertActivities(rows);
}

/** The newest block already stored for this treasury (from the stream or an earlier read), if any. */
function storedTop(t: string): bigint | null {
  const r = db().select({ b: max(schema.activity.blockNumber) }).from(schema.activity).where(sql`lower(${schema.activity.treasury}) = ${t}`).get();
  return r?.b != null ? BigInt(r.b) : null;
}

/** Where a treasury's first read stops going back: its start (from Arc's block time), the stored rows, or 3 days. */
async function floorFor(t: string, latest: bigint, createdAt: string | undefined) {
  let floor = latest > FIRST_LOOK ? latest - FIRST_LOOK : 0n;
  if (createdAt) {
    const blocks = BigInt(Math.ceil(((Date.now() - Date.parse(createdAt)) / 1000 / 0.7) * 1.2)) + 2_000n; // Arc ≈ 0.7 s a block
    if (latest - blocks > floor) floor = latest - blocks;
  }
  const stored = storedTop(t);
  if (stored !== null && stored + 1n > floor) floor = stored + 1n;
  return floor;
}

async function run(t: Address, createdAt: string | undefined) {
  const latest = await paced(() => rpc.getBlockNumber());
  let s = syncs.get(t)!;
  if (s.floor < 0n) {
    // first read: nothing covered yet; walk back from the newest block
    s = { ...s, top: latest, bottom: latest + 1n, floor: await floorFor(t, latest, createdAt) };
    syncs.set(t, s);
  }
  // new blocks first (usually one chunk)
  while (s.top < latest) {
    const from = s.top + 1n;
    const to = from + CHUNK - 1n < latest ? from + CHUNK - 1n : latest;
    await storeChunk(t, await logsIn(t, from, to));
    s = { ...syncs.get(t)!, top: to };
    syncs.set(t, s);
  }
  // then back in time, newest first, until the floor
  while (s.bottom > s.floor) {
    const to = s.bottom - 1n;
    const from = to - CHUNK + 1n > s.floor ? to - CHUNK + 1n : s.floor;
    await storeChunk(t, await logsIn(t, from, to));
    s = { ...syncs.get(t)!, bottom: from };
    syncs.set(t, s);
  }
}

/**
 * Bring this treasury's activity up to date, in the background. Returns at once; at most one read runs per treasury,
 * at most every 15 s, and not while it is waiting out a refusal.
 */
export function syncTreasuryActivity(treasury: Address, createdAt?: string): void {
  const t = treasury.toLowerCase() as Address;
  const s = syncs.get(t) ?? { top: -1n, bottom: -1n, floor: -1n, at: 0, pausedUntil: 0 };
  const now = Date.now();
  if (s.running || now < s.pausedUntil || now - s.at < EVERY_MS) return;
  const running = run(t, createdAt)
    .catch((e) => {
      console.warn(`[activity] Arc read paused for ${BACKOFF_MS / 1000} s: ${(e as Error).message.split("\n")[0]}`);
      const cur = syncs.get(t);
      if (cur) syncs.set(t, { ...cur, pausedUntil: Date.now() + BACKOFF_MS });
    })
    .finally(() => {
      const cur = syncs.get(t);
      if (cur) syncs.set(t, { ...cur, at: Date.now(), running: undefined });
    });
  syncs.set(t, { ...s, at: now, running });
}
