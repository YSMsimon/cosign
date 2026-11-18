import "./_env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { GET as jokeGET } from "../../src/app/api/sellers/joke-api/joke/route";
import { GET as keyGET } from "../../src/app/api/sellers/joke-api/key/route";
import { issueBillsKey } from "../../src/lib/demo-bills";
import { issueJokeKey, JOKES } from "../../src/lib/demo-jokes";
import { callLine, paidLine } from "../../src/lib/x402/label";

const BASE = "http://localhost:3000/api/sellers/joke-api";
const joke = (headers: Record<string, string> = {}) => jokeGET(new Request(`${BASE}/joke`, { headers }));

test("without a key the Joke API answers 401 and says where to buy one", async () => {
  const r = joke();
  assert.equal(r.status, 401);
  const body = (await r.json()) as { error: string; get_key: { url: string; price: string } };
  assert.equal(body.error, "API key required");
  assert.equal(body.get_key.url, `${BASE}/key`);
  assert.equal(body.get_key.price, "$0.01 USDC");
});

test("its key shop asks for an x402 payment first", async () => {
  const r = await keyGET(new Request(`${BASE}/key`));
  assert.equal(r.status, 402);
  const body = (await r.json()) as { resource: { description: string }; accepts: { amount: string }[] };
  assert.match(body.resource.description, /^Joke API key/);
  assert.equal(body.accepts[0].amount, "10000");
});

test("a new key gets the joke of the day first, then the rest in order", async () => {
  const { key } = issueJokeKey();
  const first = (await joke({ "X-API-Key": key }).json()) as { joke: string; of_the_day: boolean };
  assert.equal(first.joke, JOKES[0].joke);
  assert.equal(first.of_the_day, true);
  const second = (await joke({ "X-API-Key": key }).json()) as { joke: string; of_the_day: boolean };
  assert.equal(second.joke, JOKES[1].joke);
  assert.equal(second.of_the_day, false);
});

test("keys don't cross APIs: a Bills API key can't read jokes", () => {
  const { key } = issueBillsKey();
  assert.equal(joke({ "X-API-Key": key }).status, 401);
});

test("the steps read in plain words", () => {
  assert.equal(callLine(`${BASE}/joke`, 401, false), "Called Joke API · API key required");
  assert.equal(paidLine(`${BASE}/key`, { rail: "gateway", amountUsd: "0.01" }), "Paid $0.01 by nanopayment · Joke API key");
  assert.equal(callLine(`${BASE}/joke`, 200, true), "Read Joke API with its API key");
});
