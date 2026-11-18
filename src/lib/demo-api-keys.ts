/**
 * Short-lived API keys for Cosign's demo APIs (the Joke API, the Bills API). Server-only.
 *
 * The pattern a real data API would use to sell access to agents without accounts: a call without a key answers 401
 * and says where to buy one; the key itself is sold over x402 (HTTP 402, paid by nanopayment) and is good for
 * KEY_TTL_MIN minutes. Each API has its own keys. Keys live in this process's memory only (they expire anyway).
 */
import { randomBytes } from "node:crypto";

export const KEY_PRICE_USD = "0.01";
export const KEY_TTL_MIN = 15;

type KeyRow = { api: string; expiresAt: number };
const g = globalThis as unknown as { __cosignDemoKeys?: Map<string, KeyRow> };
const keys: Map<string, KeyRow> = (g.__cosignDemoKeys ??= new Map<string, KeyRow>());

/** A new key for `api` (e.g. "joke"), good for KEY_TTL_MIN minutes. Call after the x402 payment settled. */
export function issueKey(api: string, prefix: string, now = Date.now()) {
  for (const [k, v] of keys) if (v.expiresAt <= now) keys.delete(k); // forget expired keys
  const key = `${prefix}_${randomBytes(12).toString("hex")}`;
  const expiresAt = now + KEY_TTL_MIN * 60_000;
  keys.set(key, { api, expiresAt });
  return { key, expiresAt: new Date(expiresAt).toISOString() };
}

/** The key a request carries (X-API-Key, or Authorization: Bearer), if `api` sold it and it hasn't expired. */
export function keyOf(req: Request, api: string, now = Date.now()): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const key = (req.headers.get("x-api-key") ?? (auth.startsWith("Bearer ") ? auth.slice(7) : "")).trim();
  const row = key ? keys.get(key) : undefined;
  return row && row.api === api && row.expiresAt > now ? key : null;
}

/** The 401 a keyed API answers without a key: what's missing and where to buy a key, readable by people and agents. */
export function keyRequired(base: string, apiName: string) {
  return Response.json(
    {
      error: "API key required",
      message: `The ${apiName} needs an API key. Buy one over x402: call the key URL, pay its 402 ($${KEY_PRICE_USD} USDC on Arc testnet), and you get a key good for ${KEY_TTL_MIN} minutes. Send it in the X-API-Key header.`,
      get_key: { url: `${base}/key`, price: `$${KEY_PRICE_USD} USDC`, network: "Arc testnet", protocol: "x402" },
    },
    { status: 401, headers: { "WWW-Authenticate": 'ApiKey header="X-API-Key"' } },
  );
}
