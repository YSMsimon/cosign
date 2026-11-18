import { keyRequired } from "@/lib/demo-api-keys";
import { billById, billsKeyOf, knownBills } from "@/lib/demo-bills";

// The Bills API: one vendor bill per call, for callers with a key. Without a key it answers 401 and says where to buy
// one (over x402), so a person with curl, or an agent, can find its own way in.

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!billsKeyOf(req)) return keyRequired(`${new URL(req.url).origin}/api/sellers/bills-api`, "Bills API");
  const bill = billById(id);
  if (!bill) return Response.json({ error: `unknown bill ${id}`, known: knownBills() }, { status: 404 });
  return Response.json({ bill: id, ...bill, currency: "USDC" });
}
