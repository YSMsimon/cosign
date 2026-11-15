import { db, schema } from "@/lib/db";
import { requirePayment } from "@/lib/x402/seller";

// Demo paid API ($0.02/call): risk check on a payee address before paying a new vendor.
// Known = saved as a contact by a Cosign company. Flags look-alike addresses (same first 4 / last 4 hex chars as a
// known contact), a common address-poisoning pattern.
const knownContacts = () => [...new Set(db().select({ address: schema.contacts.address }).from(schema.contacts).all().map((c) => c.address))];

export async function GET(req: Request) {
  const address = (new URL(req.url).searchParams.get("address") ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return Response.json({ error: "address required" }, { status: 400 }); // before payment

  const gate = await requirePayment(req, { priceUsd: "0.02", description: "Vendor check: payee risk screen" });
  if (!gate.paid) return gate.response;
  const contacts = knownContacts();
  const known = contacts.find((c) => c.toLowerCase() === address);
  const lookalike = contacts.find(
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
