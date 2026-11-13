/**
 * QuickNode Streams REST client for the one Cosign stream (Arc testnet, dataset "logs",
 * KV-list filter, webhook destination). Server-only.
 *
 * Credits are charged per block processed (~170k blocks/day on Arc), so the stream stays paused
 * except during tests and the demo: short sessions get an end block, longer ones a local pause timer.
 */
import { buildKvFilterSource } from "./filter";
import { LIST_TREASURIES, LIST_WALLETS } from "./kv";
import { TREASURY_FACTORY_ADDRESS } from "../contracts/abis";

const API = "https://api.quicknode.com/streams/rest/v1/streams";
export const STREAM_NAME = "cosign-arc-testnet";
export const WEBHOOK_PATH = "/api/webhooks/quicknode";

export type Stream = {
  id: string;
  name: string;
  status: string;
  network: string;
  dataset: string;
  start_range?: number;
  end_range?: number;
  current_hash?: string;
  destination_attributes?: { url?: string };
  [k: string]: unknown;
};

const headers = () => ({ "x-api-key": process.env.QUICKNODE_API_KEY!, "content-type": "application/json", accept: "application/json" });

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  for (let i = 0; ; i++) {
    const r = await fetch(`${API}${path}`, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 429 && i < 5) {
      await new Promise((res) => setTimeout(res, 2000 * 2 ** i));
      continue;
    }
    const text = await r.text();
    if (!r.ok) throw new Error(`Streams ${method} ${path || "/"}: ${r.status} ${text.slice(0, 400)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

export const filterSource = () =>
  buildKvFilterSource({ factory: TREASURY_FACTORY_ADDRESS, listTreasuries: LIST_TREASURIES, listWallets: LIST_WALLETS });

export async function findStream(): Promise<Stream | null> {
  const j = await call<{ data?: Stream[] }>("GET", "?limit=100&offset=0");
  return (j.data ?? []).find((s) => s.name === STREAM_NAME) ?? null;
}

export const getStream = (id: string) => call<Stream>("GET", `/${id}`);

function destination(baseUrl: string) {
  const token = process.env.QUICKNODE_STREAM_SECURITY_TOKEN;
  if (!token || token.length < 32) throw new Error("QUICKNODE_STREAM_SECURITY_TOKEN must be set (32+ chars)");
  return {
    url: `${baseUrl.replace(/\/$/, "")}${WEBHOOK_PATH}`,
    compression: "none",
    headers: {},
    max_retry: 3,
    retry_interval_sec: 1,
    post_timeout_sec: 10,
    security_token: token,
  };
}

/**
 * Create the stream (paused) or update its filter + webhook URL + range.
 * endBlock: QuickNode rejects an end more than 500 blocks (~4 min on Arc) past the tip; pass -1 for open-ended.
 */
export async function upsertStream(baseUrl: string, startBlock: number, endBlock: number): Promise<Stream> {
  const common = {
    filter_function: Buffer.from(filterSource()).toString("base64"),
    destination: "webhook",
    destination_attributes: destination(baseUrl),
    start_range: startBlock,
    end_range: endBlock,
  };
  const existing = await findStream();
  if (!existing) {
    return call<Stream>("POST", "", {
      name: STREAM_NAME,
      network: "arc-testnet",
      dataset: "logs",
      region: "usa_east",
      dataset_batch_size: 1, // the trial plan caps batches at 1 block ("max batch size: 1")
      elastic_batch_enabled: true,
      include_stream_metadata: "body",
      status: "paused",
      ...common,
    });
  }
  return call<Stream>("PATCH", `/${existing.id}`, common);
}

export const activateStream = (id: string) => call<unknown>("POST", `/${id}/activate`);
export const pauseStream = (id: string) => call<unknown>("POST", `/${id}/pause`);
