/**
 * QuickNode Key-Value Store lists used by the Streams filter (live watchlists).
 * Our server keeps them in sync whenever a company or agent is created. Server-only.
 */
const KV = "https://api.quicknode.com/kv/rest/v1/lists";
export const LIST_TREASURIES = "cosign-treasuries";
export const LIST_WALLETS = "cosign-wallets";

const headers = () => ({ "x-api-key": process.env.QUICKNODE_API_KEY!, "content-type": "application/json", accept: "application/json" });

async function getList(key: string): Promise<string[] | null> {
  const r = await fetch(`${KV}/${key}`, { headers: headers() });
  if (r.status === 404) return null;
  const j = (await r.json().catch(() => ({}))) as { data?: { items?: string[] | null } };
  if (!r.ok) throw new Error(`KV get ${key}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  // a missing key answers 200 with items: null; PATCH with addItems creates it (verified 2026-11-13)
  return j.data?.items ?? [];
}

/** Make the list contain exactly `items` (lowercased). Returns what changed. */
export async function syncList(key: string, items: string[]) {
  const want = [...new Set(items.map((x) => x.toLowerCase()))];
  const have = await getList(key);
  if (have === null) {
    const r = await fetch(KV, { method: "POST", headers: headers(), body: JSON.stringify({ key, items: want }) });
    if (!r.ok) throw new Error(`KV create ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return { key, created: true, added: want.length, removed: 0 };
  }
  const haveSet = new Set(have.map((x) => x.toLowerCase()));
  const addItems = want.filter((x) => !haveSet.has(x));
  const removeItems = [...haveSet].filter((x) => !want.includes(x));
  if (addItems.length || removeItems.length) {
    const r = await fetch(`${KV}/${key}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ addItems, removeItems }) });
    if (!r.ok) throw new Error(`KV update ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  return { key, created: false, added: addItems.length, removed: removeItems.length };
}

/** Start watching new addresses (idempotent add). Called when a company or agent wallet is created. */
export async function watchAddresses(o: { treasuries?: string[]; wallets?: string[] }) {
  if (!process.env.QUICKNODE_API_KEY) return { skipped: true };
  const t = [...new Set((o.treasuries ?? []).map((x) => x.toLowerCase()))];
  // the wallet list also holds treasuries, so USDC deposits into a treasury are seen
  const w = [...new Set([...(o.wallets ?? []), ...t].map((x) => x.toLowerCase()))];
  const patch = async (key: string, addItems: string[]) => {
    if (!addItems.length) return;
    const r = await fetch(`${KV}/${key}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ addItems, removeItems: [] }) });
    if (!r.ok) throw new Error(`KV add ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  };
  await patch(LIST_TREASURIES, t);
  await patch(LIST_WALLETS, w);
  return { treasuries: t.length, wallets: w.length };
}
