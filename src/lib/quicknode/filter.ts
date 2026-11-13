/**
 * QuickNode Streams filter for Cosign (Arc testnet, dataset "logs").
 * The JavaScript source returned here runs ON QuickNode for every block and returns only:
 *   1. TreasuryCreated events from our factory (new companies)
 *   2. Our treasury events (ProposalCreated, ProposalApproved, PaymentExecuted, AgentToppedUp, ...)
 *   3. USDC Transfer logs touching our wallets: ONLY from Arc's system emitter (0xfff…fffe), which
 *      logs every USDC movement (native and ERC-20). The USDC contract (0x3600…) emits a duplicate
 *      Transfer for ERC-20-interface transfers, so we ignore those to avoid double counting.
 * Returns null when a block has nothing for us (no webhook call).
 */
import { toEventSelector, type AbiEvent } from "viem";
import { companyTreasuryAbi, treasuryFactoryAbi } from "../contracts/abis";

export const ARC_SYSTEM_EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe";
export const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");

const events = (abi: readonly unknown[]) => abi.filter((x) => (x as { type: string }).type === "event") as AbiEvent[];
export const TREASURY_TOPICS = Object.fromEntries(events(companyTreasuryAbi).map((e) => [toEventSelector(e), e.name]));
export const TREASURY_CREATED_TOPIC = toEventSelector(events(treasuryFactoryAbi).find((e) => e.name === "TreasuryCreated")!);

export type Watchlist = { factory: string; treasuries: string[]; wallets: string[] };

export function buildFilterSource(w: Watchlist): string {
  const lc = (a: string[]) => JSON.stringify([...new Set(a.map((x) => x.toLowerCase()))]);
  return `function main(stream) {
  var FACTORY = ${JSON.stringify(w.factory.toLowerCase())};
  var TREASURIES = new Set(${lc(w.treasuries)});
  var WALLETS = new Set(${lc([...w.wallets, ...w.treasuries])});
  var TREASURY_TOPICS = new Set(${JSON.stringify(Object.keys(TREASURY_TOPICS))});
  var CREATED = ${JSON.stringify(TREASURY_CREATED_TOPIC)};
  var TRANSFER = ${JSON.stringify(TRANSFER_TOPIC)};
  var SYS = ${JSON.stringify(ARC_SYSTEM_EMITTER)};
  function flat(x) {
    if (Array.isArray(x)) { var out = []; for (var i = 0; i < x.length; i++) out = out.concat(flat(x[i])); return out; }
    if (x && x.topics) return [x];
    if (x && x.logs) return flat(x.logs);
    return [];
  }
  function addr(topic) { return topic ? ("0x" + topic.slice(26)).toLowerCase() : ""; }
  var events = [];
  var logs = flat(stream.data);
  for (var i = 0; i < logs.length; i++) {
    var l = logs[i];
    var a = (l.address || "").toLowerCase();
    var t = l.topics || [];
    var keep = false;
    if (a === FACTORY && t[0] === CREATED) keep = true;
    else if (TREASURIES.has(a) && TREASURY_TOPICS.has(t[0])) keep = true;
    else if (a === SYS && t[0] === TRANSFER && (WALLETS.has(addr(t[1])) || WALLETS.has(addr(t[2])))) keep = true;
    if (keep) events.push({
      address: a, topics: t, data: l.data,
      blockNumber: l.blockNumber, blockHash: l.blockHash, blockTimestamp: l.blockTimestamp || null,
      transactionHash: l.transactionHash, logIndex: l.logIndex
    });
  }
  return events.length ? { cosign: 1, events: events } : null;
}`;
}

/**
 * Same filter, but the watched addresses live in QuickNode Key-Value Store lists, checked with
 * qnLib.qnContainsListItems (batched; free inside filters). Adding a company or agent only needs a
 * list update, never a stream redeploy.
 */
export function buildKvFilterSource(o: { factory: string; listTreasuries: string; listWallets: string }): string {
  return `async function main(stream) {
  var FACTORY = ${JSON.stringify(o.factory.toLowerCase())};
  var TREASURY_TOPICS = new Set(${JSON.stringify(Object.keys(TREASURY_TOPICS))});
  var CREATED = ${JSON.stringify(TREASURY_CREATED_TOPIC)};
  var TRANSFER = ${JSON.stringify(TRANSFER_TOPIC)};
  var SYS = ${JSON.stringify(ARC_SYSTEM_EMITTER)};
  function flat(x) {
    if (Array.isArray(x)) { var out = []; for (var i = 0; i < x.length; i++) out = out.concat(flat(x[i])); return out; }
    if (x && x.topics) return [x];
    if (x && x.logs) return flat(x.logs);
    return [];
  }
  function addr(topic) { return topic ? ("0x" + topic.slice(26)).toLowerCase() : ""; }
  var logs = flat(stream.data);
  // pass 1: collect candidate addresses for one batched lookup per list
  var tCand = {}, wCand = {};
  for (var i = 0; i < logs.length; i++) {
    var l = logs[i], a = (l.address || "").toLowerCase(), t = l.topics || [];
    if (TREASURY_TOPICS.has(t[0])) tCand[a] = 1;
    if (a === SYS && t[0] === TRANSFER) { wCand[addr(t[1])] = 1; wCand[addr(t[2])] = 1; }
  }
  var tList = Object.keys(tCand), wList = Object.keys(wCand);
  var tHit = tList.length ? await qnLib.qnContainsListItems(${JSON.stringify(o.listTreasuries)}, tList) : [];
  var wHit = wList.length ? await qnLib.qnContainsListItems(${JSON.stringify(o.listWallets)}, wList) : [];
  var T = new Set(tList.filter(function (_, i) { return tHit[i]; }));
  var W = new Set(wList.filter(function (_, i) { return wHit[i]; }));
  // pass 2: keep matches
  var events = [];
  for (var j = 0; j < logs.length; j++) {
    var l2 = logs[j], a2 = (l2.address || "").toLowerCase(), t2 = l2.topics || [];
    var keep = (a2 === FACTORY && t2[0] === CREATED) || (T.has(a2) && TREASURY_TOPICS.has(t2[0])) ||
      (a2 === SYS && t2[0] === TRANSFER && (W.has(addr(t2[1])) || W.has(addr(t2[2]))));
    if (keep) events.push({ address: a2, topics: t2, data: l2.data, blockNumber: l2.blockNumber, blockHash: l2.blockHash,
      blockTimestamp: l2.blockTimestamp || null, transactionHash: l2.transactionHash, logIndex: l2.logIndex });
  }
  return events.length ? { cosign: 1, events: events } : null;
}`;
}

/** Run a filter locally (tests / previews), exactly as QuickNode would call it. `lists` emulates qnLib. */
export async function runFilterLocally(source: string, streamData: unknown, lists: Record<string, string[]> = {}): Promise<unknown> {
  const qnLib = {
    qnContainsListItems: async (key: string, items: string[]) => {
      const set = new Set((lists[key] ?? []).map((x) => x.toLowerCase()));
      return items.map((i) => set.has(i.toLowerCase()));
    },
  };
  const main = new Function("qnLib", `${source}; return main;`)(qnLib) as (s: unknown) => unknown;
  return await main({ data: streamData, metadata: { local: true } });
}
