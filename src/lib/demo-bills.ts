/**
 * The demo vendor bills. Server-only.
 *
 * Two demo services read these bills:
 *   - the bill reader (/api/sellers/bill-reader): x402 per call, $0.01 a read (kept for older history and jobs);
 *   - the Bills API (/api/sellers/bills-api): needs an API key, sold over x402 (see demo-api-keys.ts).
 */
import { issueKey, keyOf } from "./demo-api-keys";

export { KEY_PRICE_USD, KEY_TTL_MIN } from "./demo-api-keys";

export type Bill = { vendor: string; amountUsd: string; due: string; memo: string };

const BILLS: Record<string, Bill> = {
  "118": { vendor: "Pixel Studio", amountUsd: "1.50", due: "2026-11-20", memo: "Logo + brand kit, milestone 2" },
  "119": { vendor: "Northpine Hosting Inc.", amountUsd: "0.08", due: "2026-10-22", memo: "Hosting, October" },
  "120": { vendor: "Oliver Grant (contractor)", amountUsd: "2.40", due: "2026-11-21", memo: "Frontend work, week 46" },
  "121": { vendor: "Northpine Hosting Inc.", amountUsd: "0.80", due: "2026-11-22", memo: "Hosting, November" },
  // the first example in the earlier video cut: a bill no earlier payment names, so a check finds $0.72 missing
  "161": { vendor: "Northpine Hosting Inc.", amountUsd: "0.80", due: "2026-11-30", memo: "Hosting, December" },
};

/** Oliver Grant (contractor) bills weekly: 122 is week 47, 123 week 48, … up to 160. A demo take pays a fresh one. */
function weekly(id: string): Bill | undefined {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 122 || n > 160) return undefined;
  return { vendor: "Oliver Grant (contractor)", amountUsd: "2.40", due: "2026-11-28", memo: `Frontend work, week ${n - 75}` };
}

export const billById = (id: string): Bill | undefined => BILLS[id] ?? weekly(id);
export const knownBills = () => Object.keys(BILLS);

/** A Bills API key (call after the x402 payment settled). */
export const issueBillsKey = (now = Date.now()) => issueKey("bills", "bk", now);
/** The Bills API key a request carries, if valid. */
export const billsKeyOf = (req: Request, now = Date.now()) => keyOf(req, "bills", now);
