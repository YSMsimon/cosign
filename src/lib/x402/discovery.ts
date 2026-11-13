/**
 * Find paid x402 services through Circle's Agent Marketplace Discovery API (public, no key).
 * Listing text is UNTRUSTED data: we only extract URLs/prices/rails and truncate descriptions;
 * nothing in a listing is ever treated as an instruction.
 */
import { ARC_NETWORK } from "./shared";

const DISCOVERY = "https://api.circle.com/v2/x402/discovery/resources";

export type DiscoveredService = {
  url: string;
  provider: string;
  category: string;
  description: string;
  arcOptions: { rail: "gateway" | "vanilla"; priceUsd: string }[];
};

type RawItem = {
  resource?: string;
  description?: string;
  accepts?: { network?: string; amount?: string; extra?: { name?: string } }[];
  metadata?: { provider?: { name?: string; category?: string }; description?: string };
};

const clean = (s: unknown, n: number) =>
  String(s ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export async function discoverServices(opts: { category?: string; query?: string; limit?: number } = {}) {
  const u = new URL(DISCOVERY);
  u.searchParams.set("network", ARC_NETWORK);
  u.searchParams.set("limit", String(opts.limit ?? 50));
  if (opts.category) u.searchParams.set("category", opts.category);
  if (opts.query) u.searchParams.set("query", opts.query);
  const res = await fetch(u, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`discovery failed: ${res.status}`);
  const json = (await res.json()) as { items?: RawItem[] };

  const out: DiscoveredService[] = [];
  for (const it of json.items ?? []) {
    const url = clean(it.resource, 300);
    if (!/^https:\/\/[^\s"'<>]+$/.test(url)) continue; // only plain https URLs
    const arcOptions = (it.accepts ?? [])
      .filter((a) => a.network === ARC_NETWORK && /^\d+$/.test(a.amount ?? ""))
      .map((a) => ({
        rail: (a.extra?.name === "GatewayWalletBatched" ? "gateway" : "vanilla") as "gateway" | "vanilla",
        priceUsd: (Number(a.amount) / 1e6).toString(),
      }));
    if (!arcOptions.length) continue;
    out.push({
      url,
      provider: clean(it.metadata?.provider?.name, 60),
      category: clean(it.metadata?.provider?.category, 40),
      description: clean(it.description ?? it.metadata?.description, 160),
      arcOptions,
    });
  }
  return out;
}
