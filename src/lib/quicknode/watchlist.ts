/** Addresses the Stream watches (later from the DB; for now from local demo state). Server-only. */
import { existsSync, readFileSync } from "node:fs";
import { TREASURY_FACTORY_ADDRESS } from "../contracts/abis";
import type { Watchlist } from "./filter";

export function currentWatchlist(): Watchlist {
  const treasuries: string[] = [];
  const wallets: string[] = [];
  if (existsSync("data/treasury.local.json")) treasuries.push(JSON.parse(readFileSync("data/treasury.local.json", "utf8")).treasury);
  if (existsSync("data/wallets.local.json")) {
    for (const w of JSON.parse(readFileSync("data/wallets.local.json", "utf8")).wallets as { address: string }[]) wallets.push(w.address);
  }
  return { factory: TREASURY_FACTORY_ADDRESS, treasuries, wallets };
}
