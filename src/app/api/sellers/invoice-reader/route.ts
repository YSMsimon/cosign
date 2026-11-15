import { requirePayment } from "@/lib/x402/seller";

// Demo paid API ($0.01/call): "reads" an invoice and returns structured fields.
// Stand-in for a real OCR/invoice-parsing service an agent would buy per request.
const INVOICES: Record<string, { vendor: string; amountUsd: string; due: string; memo: string }> = {
  "118": { vendor: "Pixel Studio", amountUsd: "1.50", due: "2026-11-20", memo: "Logo + brand kit, milestone 2" },
  "119": { vendor: "Northpine Hosting Inc.", amountUsd: "0.08", due: "2026-10-22", memo: "Hosting, October" },
  "120": { vendor: "Oliver Grant (contractor)", amountUsd: "2.40", due: "2026-11-21", memo: "Frontend work, week 46" },
  "121": { vendor: "Northpine Hosting Inc.", amountUsd: "0.80", due: "2026-11-22", memo: "Hosting, November" },
};

/** Oliver Grant (contractor) invoices weekly: 122 is week 47, 123 week 48, … up to 160. A demo take pays a fresh one. */
function weekly(id: string) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 122 || n > 160) return undefined;
  return { vendor: "Oliver Grant (contractor)", amountUsd: "2.40", due: "2026-11-28", memo: `Frontend work, week ${n - 75}` };
}

export async function GET(req: Request) {
  // Unknown invoices answer 404 before the payment gate: nobody pays to learn an invoice doesn't exist.
  const id = new URL(req.url).searchParams.get("invoice") ?? "118";
  const invoice = INVOICES[id] ?? weekly(id);
  if (!invoice) return Response.json({ error: `unknown invoice ${id}`, known: Object.keys(INVOICES) }, { status: 404 });

  const gate = await requirePayment(req, { priceUsd: "0.01", description: "Invoice reader: parse one invoice" });
  if (!gate.paid) return gate.response;
  return Response.json({ invoice: id, ...invoice, currency: "USDC" }, { headers: gate.headers });
}
