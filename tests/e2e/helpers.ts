/**
 * End-to-end helpers: people with real wallets (throwaway keys, Arc testnet), wallet sign-in, API
 * calls with their session cookie, SSE parsing, sending prepared transactions, and a mock Grok Bot
 * routine that behaves like the webhook pattern (ack → context → tool calls → progress → result).
 */
import { createServer, type Server } from "node:http";
import { createWalletClient, http, type Hash } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { arcTestnet, chain, sendUsdc } from "../../src/lib/arc";

export const APP = process.env.APP_URL ?? "http://localhost:3000";
export type Person = { name: string; account: PrivateKeyAccount; address: string; cookie?: string };
export type PreparedTx = { chainId: number; to: `0x${string}`; data: `0x${string}`; value: string; description: string };

export function person(name: string): Person {
  const account = privateKeyToAccount(generatePrivateKey());
  return { name, account, address: account.address.toLowerCase() };
}

export async function api(p: Person | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${APP}/api/v1${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(p?.cookie ? { cookie: p.cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: r.status, json, headers: r.headers };
}

export async function siweFor(p: Person, o: { domain?: string } = {}) {
  const { json } = await api(null, "GET", "/auth/nonce");
  const u = new URL(APP);
  const message = createSiweMessage({ address: p.account.address, chainId: 5042002, domain: o.domain ?? u.host, nonce: json.nonce, uri: APP, version: "1", issuedAt: new Date(Date.now() - 1000) });
  return { message, signature: await p.account.signMessage({ message }) };
}

export async function signIn(p: Person) {
  const s = await siweFor(p);
  const r = await api(null, "POST", "/auth/verify", s);
  if (r.status !== 200) throw new Error(`sign-in failed for ${p.name}: ${r.status} ${JSON.stringify(r.json)}`);
  p.cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return r.json;
}

export type SseEvent = { event: string; data: any };
export async function sse(p: Person, path: string, body: unknown): Promise<{ status: number; events: SseEvent[]; done?: any; error?: any; steps: any[] }> {
  const r = await fetch(`${APP}/api/v1${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: p.cookie ?? "" }, body: JSON.stringify(body) });
  if (!(r.headers.get("content-type") ?? "").includes("text/event-stream")) return { status: r.status, events: [], steps: [], error: await r.json().catch(() => null) };
  const text = await r.text();
  const events: SseEvent[] = [];
  for (const chunk of text.split("\n\n")) {
    const ev = chunk.match(/^event: (.+)$/m)?.[1];
    const data = chunk.match(/^data: (.+)$/m)?.[1];
    if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
  }
  return { status: r.status, events, steps: events.filter((e) => e.event === "step").map((e) => e.data), done: events.find((e) => e.event === "done")?.data, error: events.find((e) => e.event === "error")?.data };
}

export async function send(p: Person, tx: PreparedTx): Promise<Hash> {
  const wc = createWalletClient({ account: p.account, chain: arcTestnet, transport: http(process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.io") });
  const hash = await wc.sendTransaction({ to: tx.to, data: tx.data === "0x" ? undefined : tx.data, value: BigInt(tx.value) });
  const receipt = await chain.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error(`${tx.description}: reverted (${hash})`);
  return hash;
}

/** Testnet USDC for a throwaway wallet, from the demo CFO (Circle wallet). */
export const fund = (address: string, amount: string) => sendUsdc("test-cfo", address as `0x${string}`, amount);

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000, every = 1000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * A stand-in for the Grok Bot webhook routine. Checks the webhook key, answers 200 at once, then
 * works like the routine our setup message describes. For tests, `instructions` may be a JSON plan
 * {"calls":[{"name":"...","args":{...}}]} that it runs against the tools endpoint.
 */
export function startMockBot(port: number, key: string) {
  const seen: { body: any; token: string; results?: any[] }[] = [];
  const post = (url: string, token: string, body: unknown) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      if (req.headers.authorization !== `Bearer ${key}`) {
        res.writeHead(401).end("bad key");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      const body = JSON.parse(raw);
      const token = body.callbacks.bearer as string;
      const entry: { body: any; token: string; results?: any[] } = { body, token };
      seen.push(entry);
      await post(body.callbacks.ack, token, { note: "on it" });
      if (body.kind === "ping") return;
      const results: any[] = [];
      const ctx = await fetch(body.api.context_url, { headers: { authorization: `Bearer ${body.api.token}` } });
      results.push({ name: "context", status: ctx.status, body: await ctx.json() });
      let plan: { calls: { name: string; args: Record<string, unknown> }[] } = { calls: [{ name: "get_balances", args: {} }] };
      try {
        plan = JSON.parse(body.instructions);
      } catch {}
      for (const c of plan.calls) {
        const r = await fetch(body.api.tools_url.replace("{name}", c.name), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${body.api.token}` },
          body: JSON.stringify({ args: c.args }),
        });
        results.push({ name: c.name, status: r.status, body: await r.json() });
        await post(body.callbacks.progress, token, { message: `${c.name}: HTTP ${r.status}` });
      }
      entry.results = results;
      await post(body.callbacks.result, token, { result: JSON.stringify(results.map((r) => ({ name: r.name, status: r.status }))) });
    });
  });
  server.listen(port, "127.0.0.1");
  return { url: `http://127.0.0.1:${port}/hook`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}
