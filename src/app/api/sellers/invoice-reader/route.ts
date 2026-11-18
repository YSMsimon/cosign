import { billById, knownBills } from "@/lib/demo-bills";
import { requirePayment } from "@/lib/x402/seller";

// Demo paid API ($0.01/call): "reads" a vendor bill and returns structured fields. On screen and in the catalog it was
// the "bill reader" (/api/sellers/bill-reader re-exports this); this path stays for older history and jobs. The demo
// now reads bills from the Bills API (/api/sellers/bills-api), which sells a short-lived key over x402.
// Stand-in for a real OCR/bill-parsing service an agent would buy per request.

export async function GET(req: Request) {
  // Unknown bills answer 404 before the payment gate: nobody pays to learn a bill doesn't exist.
  const params = new URL(req.url).searchParams;
  const id = params.get("bill") ?? params.get("invoice") ?? "118";
  const invoice = billById(id);
  if (!invoice) return Response.json({ error: `unknown bill ${id}`, known: knownBills() }, { status: 404 });

  const gate = await requirePayment(req, { priceUsd: "0.01", description: "Bill reader: read one vendor bill" });
  if (!gate.paid) return gate.response;
  return Response.json({ bill: id, ...invoice, currency: "USDC" }, { headers: gate.headers });
}
