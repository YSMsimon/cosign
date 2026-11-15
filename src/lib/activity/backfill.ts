/**
 * Read a treasury's history straight from Arc when the activity is asked for: its own events (drafts, cosigns,
 * payments, cancels, petty cash, approver changes) and the USDC that moved in or out of it. The QuickNode stream
 * writes the same rows when it runs (deduped on tx hash + log index); this covers the time it doesn't. Server-only.
 */
import { pad, type Address } from "viem";
import { chain } from "../arc";
import type { NewActivity } from "../db/schema";
import { ARC_SYSTEM_EMITTER, TRANSFER_TOPIC } from "../quicknode/filter";
import { addressBook, decodeStreamLog } from "./decode";
import { insertActivities } from "./store";

const CHUNK = 10_000n;
const FIRST_LOOK = 400_000n; // at most this many blocks back on the first read of a treasury
const EVERY_MS = 10_000;
type Sync = { block: bigint | null; at: number; running?: Promise<void> };
const g = globalThis as unknown as { __cosignLogSync?: Map<string, Sync> };
const seen = (g.__cosignLogSync ??= new Map());

type RawLog = { address: string; topics: readonly string[]; data: string; blockNumber: bigint | null; transactionHash: string | null; logIndex: number | null };

async function logsIn(t: Address, from: bigint, to: bigint): Promise<RawLog[]> {
  const topic = pad(t);
  const [own, incoming, outgoing] = await Promise.all([
    chain.getLogs({ address: t, fromBlock: from, toBlock: to }),
    chain.request({ method: "eth_getLogs", params: [{ address: ARC_SYSTEM_EMITTER, topics: [TRANSFER_TOPIC, null, topic], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] }) as Promise<
      { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string }[]
    >,
    chain.request({ method: "eth_getLogs", params: [{ address: ARC_SYSTEM_EMITTER, topics: [TRANSFER_TOPIC, topic], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] }) as Promise<
      { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string }[]
    >,
  ]);
  const norm = (l: { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string }): RawLog => ({
    address: l.address,
    topics: l.topics,
    data: l.data,
    blockNumber: BigInt(l.blockNumber),
    transactionHash: l.transactionHash,
    logIndex: Number(l.logIndex),
  });
  return [...own.map((l) => ({ ...l, topics: l.topics as readonly string[] })), ...incoming.map(norm), ...outgoing.map(norm)];
}

/** The first block worth reading for a treasury made at `createdAt` (from Arc's recent block time, with a margin). */
async function firstBlock(latest: bigint, createdAt: string | undefined) {
  const floor = latest > FIRST_LOOK ? latest - FIRST_LOOK : 0n;
  if (!createdAt) return floor;
  const back = 10_000n;
  const [now, then] = await Promise.all([chain.getBlock({ blockNumber: latest }), chain.getBlock({ blockNumber: latest - back })]);
  const perBlock = Number(now.timestamp - then.timestamp) / Number(back);
  const blocks = BigInt(Math.ceil(((Date.now() - Date.parse(createdAt)) / 1000 / Math.max(perBlock, 0.05)) * 1.2)) + 2_000n;
  const from = latest > blocks ? latest - blocks : 0n;
  return from > floor ? from : floor;
}

async function run(treasury: Address, createdAt?: string) {
  const t = treasury.toLowerCase() as Address;
  const latest = await chain.getBlockNumber();
  const last = seen.get(t)?.block ?? null;
  let from = last !== null ? last + 1n : await firstBlock(latest, createdAt);
  const names = addressBook();
  const rows: NewActivity[] = [];
  const times = new Map<bigint, number>();
  while (from <= latest) {
    const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
    for (const l of await logsIn(t, from, to)) {
      if (l.blockNumber === null || l.transactionHash === null || l.logIndex === null) continue;
      if (!times.has(l.blockNumber)) times.set(l.blockNumber, Number((await chain.getBlock({ blockNumber: l.blockNumber })).timestamp));
      const row = decodeStreamLog(
        { address: l.address, topics: [...l.topics], data: l.data, blockNumber: Number(l.blockNumber), blockTimestamp: times.get(l.blockNumber)!, transactionHash: l.transactionHash, logIndex: l.logIndex },
        names,
      );
      // a USDC movement in or out belongs to this treasury's feed too
      if (row) rows.push({ ...row, treasury: row.treasury ?? t, source: "chain" });
    }
    from = to + 1n;
  }
  if (rows.length) insertActivities(rows);
  seen.set(t, { block: latest, at: Date.now() });
}

/** Bring this treasury's activity up to date (at most every 10 s; concurrent callers share one read). */
export async function syncTreasuryActivity(treasury: Address, createdAt?: string) {
  const t = treasury.toLowerCase();
  const s = seen.get(t);
  if (s?.running) return s.running;
  if (s && s.block !== null && Date.now() - s.at < EVERY_MS) return;
  const running = run(treasury, createdAt).finally(() => {
    const cur = seen.get(t);
    if (cur) delete cur.running;
  });
  seen.set(t, { block: s?.block ?? null, at: s?.at ?? 0, running });
  return running;
}
