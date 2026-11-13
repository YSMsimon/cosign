import { gunzipSync } from "node:zlib";
import { decodeStreamLog, addressBook, type StreamLog } from "@/lib/activity/decode";
import { insertActivities, recordDelivery } from "@/lib/activity/store";
import { watchAddresses } from "@/lib/quicknode/kv";
import { verifyQuickNode } from "@/lib/quicknode/verify";

// QuickNode Streams webhook: verify HMAC → decode → store (idempotent) → 200 fast.
export async function POST(req: Request) {
  const buf = Buffer.from(await req.arrayBuffer());
  const gz = req.headers.get("content-encoding")?.includes("gzip") || (buf[0] === 0x1f && buf[1] === 0x8b);
  const body = (gz ? gunzipSync(buf) : buf).toString("utf8");

  const v = verifyQuickNode(process.env.QUICKNODE_STREAM_SECURITY_TOKEN, req.headers, body);
  if (!v.ok) return Response.json({ error: v.reason }, { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  // our filter returns { cosign: 1, events: [...] }; tolerate wrappers/arrays of those
  const collect = (x: unknown): StreamLog[] => {
    if (Array.isArray(x)) return x.flatMap(collect);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      if (Array.isArray(o.events)) return o.events as StreamLog[];
      if (o.data) return collect(o.data);
      if (o.topics && o.transactionHash) return [o as unknown as StreamLog];
    }
    return [];
  };
  const logs = collect(payload);
  const names = addressBook();
  const rows = logs.map((l) => decodeStreamLog(l, names)).filter((r): r is NonNullable<typeof r> => r !== null);
  const inserted = insertActivities(rows);
  recordDelivery(v.nonce, logs.length, inserted.length);
  // a company created through our factory is a Cosign company: watch its treasury from now on
  const born = rows.filter((r) => r.type === "treasury_created" && r.treasury).map((r) => r.treasury!);
  if (born.length) await watchAddresses({ treasuries: born }).catch((e) => console.error("[quicknode] watch failed:", e?.message));
  return Response.json({ ok: true, received: logs.length, decoded: rows.length, inserted: inserted.length });
}
