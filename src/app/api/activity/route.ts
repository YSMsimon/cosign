import { connection } from "next/server";
import { listActivity } from "@/lib/activity/store";

// Latest decoded onchain activity for the dashboard feed.
export async function GET(req: Request) {
  await connection(); // always dynamic
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 50);
  const rows = listActivity(limit).map((r) => ({
    ...r,
    raw: undefined,
    explorer: `https://explorer.testnet.arc.io/tx/${r.txHash}`,
  }));
  return Response.json({ activity: rows });
}
