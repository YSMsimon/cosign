/**
 * How a paid API call reads on screen: "Paid $0.01 by nanopayment · invoice reader". A Gateway payment is a
 * nanopayment (signed off-chain, settled in batches); the plain x402 rail pays onchain for each call.
 * Shared by the chat's step lines and Grok Bot's task steps, so both say the same thing.
 */
const money = (x: unknown) => {
  const n = Number(x);
  return Number.isFinite(n) ? `$${n < 0.01 ? n.toFixed(3) : n.toFixed(2)}` : "";
};

/** "invoice reader" for one of our demo sellers (/api/sellers/<name>), else the API's host. */
export function sellerName(url: unknown): string {
  try {
    const u = new URL(String(url));
    const m = /\/api\/sellers\/([a-z0-9-]+)/i.exec(u.pathname);
    return m ? m[1].replace(/-/g, " ") : u.host;
  } catch {
    return "an API";
  }
}

export function paidLine(url: unknown, paid: { rail?: unknown; amountUsd?: unknown }): string {
  return `Paid ${money(paid.amountUsd)} ${paid.rail === "gateway" ? "by nanopayment" : "onchain"} · ${sellerName(url)}`;
}
