import "./_env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { GET as billGET } from "../../src/app/api/sellers/bills-api/bills/[id]/route";
import { GET as keyGET } from "../../src/app/api/sellers/bills-api/key/route";
import { billsKeyOf, issueBillsKey, KEY_TTL_MIN } from "../../src/lib/demo-bills";
import { apiKeyHeader } from "../../src/lib/agent/tools";
import { callLine, paidLine, sellerName } from "../../src/lib/x402/label";

const BASE = "http://localhost:3000/api/sellers/bills-api";
const bill = (id: string, headers: Record<string, string> = {}) => billGET(new Request(`${BASE}/bills/${id}`, { headers }), { params: Promise.resolve({ id }) });

test("without a key the Bills API answers 401 and says where to buy one", async () => {
  const r = await bill("125");
  assert.equal(r.status, 401);
  const body = (await r.json()) as { error: string; get_key: { url: string; protocol: string } };
  assert.equal(body.error, "API key required");
  assert.equal(body.get_key.url, `${BASE}/key`);
  assert.equal(body.get_key.protocol, "x402");
});

test("the key shop asks for an x402 payment first", async () => {
  const r = await keyGET(new Request(`${BASE}/key`));
  assert.equal(r.status, 402);
  const body = (await r.json()) as { x402Version: number; accepts: { network: string; amount: string }[] };
  assert.equal(body.x402Version, 2);
  assert.equal(body.accepts[0].network, "eip155:5042002");
  assert.equal(body.accepts[0].amount, "10000"); // $0.01
});

test("a sold key reads a bill (X-API-Key or Bearer); a made-up or expired key doesn't", async () => {
  const { key } = issueBillsKey();
  const ok = await bill("125", { "X-API-Key": key });
  assert.equal(ok.status, 200);
  const b = (await ok.json()) as { vendor: string; amountUsd: string; memo: string };
  assert.equal(b.vendor, "Oliver Grant (contractor)");
  assert.equal(b.amountUsd, "2.40");
  assert.equal((await bill("125", { authorization: `Bearer ${key}` })).status, 200);
  assert.equal((await bill("125", { "X-API-Key": "bk_madeup" })).status, 401);
  assert.equal((await bill("999", { "X-API-Key": key })).status, 404);
  const later = Date.now() + (KEY_TTL_MIN + 1) * 60_000;
  assert.equal(billsKeyOf(new Request(`${BASE}/bills/125`, { headers: { "X-API-Key": key } }), later), null);
});

test("paid_fetch api_key: the key goes in X-API-Key; anything that isn't a plain key is refused", () => {
  assert.deepEqual(apiKeyHeader("bk_1234"), { "X-API-Key": "bk_1234" });
  assert.deepEqual(apiKeyHeader(undefined), {});
  assert.match(String(apiKeyHeader(":{")), /the key itself/);
  assert.match(String(apiKeyHeader("a\r\nPAYMENT-SIGNATURE: x")), /the key itself/);
  assert.match(String(apiKeyHeader({ "X-API-Key": "x" })), /as a string/);
});

test("the steps read in plain words", () => {
  assert.equal(sellerName(`${BASE}/bills/125`), "Bills API");
  assert.equal(callLine(`${BASE}/bills/125`, 401, false), "Called Bills API · API key required");
  assert.equal(paidLine(`${BASE}/key`, { rail: "gateway", amountUsd: "0.01" }), "Paid $0.01 by nanopayment · Bills API key");
  assert.equal(callLine(`${BASE}/bills/125`, 200, true), "Read Bills API with its API key");
  assert.equal(paidLine("http://localhost:3000/api/sellers/vendor-check?address=0x1", { rail: "gateway", amountUsd: "0.02" }), "Paid $0.02 by nanopayment · vendor check");
});
