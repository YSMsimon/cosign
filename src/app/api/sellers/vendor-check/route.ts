import { requirePayment } from "@/lib/x402/seller";

// Demo paid API ($0.02/call): risk check on a payee address before paying a new vendor.
// Flags look-alike addresses (same first 4 / last 4 hex chars as a known contact), a common
// address-poisoning pattern.
const KNOWN_CONTACTS = ["0x7797B992389e4a03E366DAEa33E71c0a394Df1e7"]; // demo: "Pixel Studio"

export async function GET(req: Request) {
  const address = (new URL(req.url).searchParams.get("address") ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return Response.json({ error: "address required" }, { status: 400 }); // before payment

  const gate = await requirePayment(req, { priceUsd: "0.02", description: "Vendor check: payee risk screen" });
  if (!gate.paid) return gate.response;
  const known = KNOWN_CONTACTS.find((c) => c.toLowerCase() === address);
  const lookalike = KNOWN_CONTACTS.find(
    (c) => c.toLowerCase() !== address && c.toLowerCase().slice(2, 6) === address.slice(2, 6) && c.toLowerCase().slice(-4) === address.slice(-4),
  );
  return Response.json(
    {
      address,
      knownContact: Boolean(known),
      lookalikeOf: lookalike ?? null,
      risk: lookalike ? "high" : known ? "low" : "unknown",
    },
    { headers: gate.headers },
  );
}
