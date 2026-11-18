/**
 * A demo API's key shop: an API key sold over x402. The first call answers 402 with the price; a paid call returns a
 * key good for KEY_TTL_MIN minutes. No account, no sign-up: paying is the sign-up. Server-only.
 */
import { issueKey, KEY_PRICE_USD, KEY_TTL_MIN } from "../demo-api-keys";
import { requirePayment } from "./seller";

export async function sellKey(req: Request, o: { api: string; prefix: string; name: string; dataPath: string }) {
  const gate = await requirePayment(req, { priceUsd: KEY_PRICE_USD, description: `${o.name} key: ${KEY_TTL_MIN} minutes of access` });
  if (!gate.paid) return gate.response;
  const { key, expiresAt } = issueKey(o.api, o.prefix);
  const base = new URL(req.url).origin;
  return Response.json(
    { api_key: key, expires_at: expiresAt, valid_for_minutes: KEY_TTL_MIN, use: { header: "X-API-Key", url: `${base}${o.dataPath}` } },
    { headers: gate.headers },
  );
}
