import { requirePayment } from "@/lib/x402/seller";

// Demo paid API ($0.01/call): "reads" an invoice and returns structured fields.
// Stand-in for a real OCR/invoice-parsing service an agent would buy per request.
const INVOICES: Record<string, { vendor: string; amountUsd: string; due: string; memo: string }> = {
  "118": { vendor: "Pixel Studio", amountUsd: "1.50", due: "2026-11-20", memo: "Logo + brand kit, milestone 2" },
  "119": { vendor: "CloudCo", amountUsd: "0.80", due: "2026-11-22", memo: "Hosting, November" },
  "120": { vendor: "Lena (contractor)", amountUsd: "2.40", due: "2026-11-21", memo: "Frontend work, week 46" },
};

export async function GET(req: Request) {
  const gate = await requirePayment(req, { priceUsd: "0.01", description: "Invoice reader: parse one invoice" });
  if (!gate.paid) return gate.response;

  const id = new URL(req.url).searchParams.get("invoice") ?? "118";
  const invoice = INVOICES[id];
  return Response.json(
    invoice ? { invoice: id, ...invoice, currency: "USDC" } : { error: `unknown invoice ${id}` },
    { status: invoice ? 200 : 404, headers: gate.headers },
  );
}
