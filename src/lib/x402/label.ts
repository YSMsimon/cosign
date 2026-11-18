/**
 * How a paid API call reads on screen: "Paid $0.01 by nanopayment · bill reader". A Gateway payment is a
 * nanopayment (signed off-chain, settled in batches); the plain x402 rail pays onchain for each call.
 * Shared by the chat's step lines and Grok Bot's task steps, so both say the same thing.
 */
const money = (x: unknown) => {
  const n = Number(x);
  // a hundredth of a cent (QuickNode's RPC call) reads $0.0001, not $0.000
  return Number.isFinite(n) ? `$${n < 0.001 ? n.toFixed(4) : n < 0.01 ? n.toFixed(3) : n.toFixed(2)}` : "";
};

/** Sellers known by name on screen. */
const KNOWN: Record<string, string> = { "x402.quicknode.com": "QuickNode" };
/** Our demo sellers whose on-screen name isn't just their path ("bills-api" reads "Bills API"). */
const DEMO_NAMES: Record<string, string> = { "bills-api": "Bills API", "joke-api": "Joke API" };

/** "bill reader" for one of our demo sellers (/api/sellers/<name>), "QuickNode" for QuickNode, else the API's host. */
export function sellerName(url: unknown): string {
  try {
    const u = new URL(String(url));
    const m = /\/api\/sellers\/([a-z0-9-]+)/i.exec(u.pathname);
    return m ? (DEMO_NAMES[m[1].toLowerCase()] ?? m[1].replace(/-/g, " ")) : (KNOWN[u.host] ?? u.host);
  } catch {
    return "an API";
  }
}

/** A URL that sells an API key (the Bills API's /key), so the paid line says what was bought. */
const isKeyShop = (url: unknown) => {
  try {
    return /\/key\/?$/i.test(new URL(String(url)).pathname);
  } catch {
    return false;
  }
};

export function paidLine(url: unknown, paid: { rail?: unknown; amountUsd?: unknown }): string {
  return `Paid ${money(paid.amountUsd)} ${paid.rail === "gateway" ? "by nanopayment" : "onchain"} · ${sellerName(url)}${isKeyShop(url) ? " key" : ""}`;
}

/** An unpaid call to an API: "Called Bills API · API key required", "Read Bills API with its key", or "Called vendor check". */
export function callLine(url: unknown, status: unknown, withKey: boolean): string {
  const name = sellerName(url);
  if (status === 401) return `Called ${name} · API key required`;
  if (withKey && typeof status === "number" && status >= 200 && status < 300) return `Read ${name} with its API key`;
  return `Called ${name}`;
}
