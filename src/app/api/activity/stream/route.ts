import { connection } from "next/server";
import { activityBus } from "@/lib/activity/store";
import type { ActivityRow } from "@/lib/db/schema";

// Live feed: Server-Sent Events pushed as soon as a verified webhook delivery inserts activity.
export async function GET(req: Request) {
  await connection();
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const onActivity = (row: ActivityRow) =>
        send("activity", { ...row, raw: undefined, explorer: `https://explorer.testnet.arc.io/tx/${row.txHash}` });
      activityBus.on("activity", onActivity);
      const ping = setInterval(() => controller.enqueue(encoder.encode(`: ping\n\n`)), 15_000);
      send("ready", { at: new Date().toISOString() });
      cleanup = () => {
        clearInterval(ping);
        activityBus.off("activity", onActivity);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
