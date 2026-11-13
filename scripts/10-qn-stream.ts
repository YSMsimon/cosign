/**
 * Control the Cosign QuickNode Stream.
 *   status                 show the stream
 *   on <baseUrl> [minutes] point the webhook at <baseUrl> (e.g. the ngrok URL), start at the chain tip,
 *                          activate, and stop after [minutes] (default 15). Up to 4 min the stream gets an
 *                          end block and stops on QuickNode's side; longer, this script stays running and
 *                          pauses the stream when the time is up (QuickNode caps the end at tip + 500 blocks).
 *   off                    pause
 * Run: pnpm tsx --env-file=.env.local scripts/10-qn-stream.ts <command>
 */
import { activateStream, findStream, getStream, pauseStream, upsertStream } from "../src/lib/quicknode/streams";

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.io";
const BLOCKS_PER_MIN = 118; // Arc testnet ~0.51 s blocks

async function tip(): Promise<number> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
  return Number(((await r.json()) as { result: string }).result);
}

const show = (s: Record<string, unknown> | null) => {
  if (!s) return console.log("no stream yet");
  const { id, name, status, network, dataset, start_range, end_range, destination_attributes } = s as Record<string, never>;
  const d = (destination_attributes ?? {}) as { url?: string };
  console.log(JSON.stringify({ id, name, status, network, dataset, start_range, end_range, webhook: d.url }, null, 2));
};

(async () => {
  const [cmd, arg, mins] = process.argv.slice(2);
  if (cmd === "status") {
    const s = await findStream();
    show(s ? await getStream(s.id) : null);
  } else if (cmd === "on") {
    if (!arg?.startsWith("https://")) throw new Error("usage: on <https://public-base-url> [minutes]");
    const existing = await findStream();
    if (existing && existing.status === "active") await pauseStream(existing.id); // range edits need a paused stream
    const minutes = Number(mins ?? 15);
    const start = await tip();
    const span = Math.round(minutes * BLOCKS_PER_MIN);
    const bounded = span <= 500;
    const s = await upsertStream(arg, start, bounded ? start + span : -1);
    const id = (s.id ?? existing?.id) as string;
    await activateStream(id);
    console.log(`stream active from block ${start}${bounded ? ` to ${start + span}` : ", open-ended"} (~${minutes} min)`);
    show(await getStream(id));
    if (!bounded) {
      const stop = async () => {
        await pauseStream(id);
        console.log(`paused at ${new Date().toISOString()}`);
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      console.log(`keep this running: it pauses the stream in ${minutes} min (Ctrl-C pauses now)`);
      await new Promise((r) => setTimeout(r, minutes * 60_000));
      await stop();
    }
  } else if (cmd === "off") {
    const s = await findStream();
    if (!s) return console.log("no stream");
    await pauseStream(s.id);
    show(await getStream(s.id));
  } else {
    console.log("commands: status | on <baseUrl> [minutes] | off");
  }
})().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
});
