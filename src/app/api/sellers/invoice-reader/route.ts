import { requirePayment } from "@/lib/x402/seller";

// Demo paid API ($0.01/call): "reads" a vendor bill and returns structured fields. On screen and in the catalog it is
// the "bill reader" (/api/sellers/bill-reader re-exports this); this path stays for older history and jobs.
// Stand-in for a real OCR/bill-parsing service an agent would buy per request.
const INVOICES: Record<string, { vendor: string; amountUsd: string; due: string; memo: string }> = {
  "118": { vendor: "Pixel Studio", amountUsd: "1.50", due: "2026-11-20", memo: "Logo + brand kit, milestone 2" },
  "119": { vendor: "Northpine Hosting Inc.", amountUsd: "0.08", due: "2026-10-22", memo: "Hosting, October" },
  "120": { vendor: "Oliver Grant (contractor)", amountUsd: "2.40", due: "2026-11-21", memo: "Frontend work, week 46" },
  "121": { vendor: "Northpine Hosting Inc.", amountUsd: "0.80", due: "2026-11-22", memo: "Hosting, November" },
  // the first example in the video, re-recorded 2026-11-15: a bill no earlier payment names, so the check finds $0.72 missing
  "161": { vendor: "Northpine Hosting Inc.", amountUsd: "0.80", due: "2026-11-30", memo: "Hosting, December" },
};

/** Oliver Grant (contractor) invoices weekly: 122 is week 47, 123 week 48, … up to 160. A demo take pays a fresh one. */
function weekly(id: string) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 122 || n > 160) return undefined;
  return { vendor: "Oliver Grant (contractor)", amountUsd: "2.40", due: "2026-11-28", memo: `Frontend work, week ${n - 75}` };
}

export async function GET(req: Request) {
  // Unknown bills answer 404 before the payment gate: nobody pays to learn a bill doesn't exist.
  const params = new URL(req.url).searchParams;
  const id = params.get("bill") ?? params.get("invoice") ?? "118";
  const invoice = INVOICES[id] ?? weekly(id);
  if (!invoice) return Response.json({ error: `unknown bill ${id}`, known: Object.keys(INVOICES) }, { status: 404 });

  const gate = await requirePayment(req, { priceUsd: "0.01", description: "Bill reader: read one vendor bill" });
  if (!gate.paid) return gate.response;
  return Response.json({ bill: id, ...invoice, currency: "USDC" }, { headers: gate.headers });
}
