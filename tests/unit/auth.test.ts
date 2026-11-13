import "./_env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { AuthError, createNonce, endSession, SESSION_COOKIE, sessionAddress, verifySignIn } from "../../src/lib/auth";

const HOST = "localhost:3000";
const account = privateKeyToAccount(generatePrivateKey());

async function signed(o: { nonce?: string; domain?: string; chainId?: number; expired?: boolean } = {}) {
  const message = createSiweMessage({
    address: account.address,
    chainId: o.chainId ?? 5042002,
    domain: o.domain ?? HOST,
    nonce: o.nonce ?? createNonce(),
    uri: `http://${o.domain ?? HOST}`,
    version: "1",
    issuedAt: new Date(Date.now() - 1000),
    ...(o.expired ? { expirationTime: new Date(Date.now() - 500) } : {}),
  });
  return { message, signature: await account.signMessage({ message }) };
}
const req = (cookie?: string) => new Request(`http://${HOST}/api/v1/me`, { headers: cookie ? { cookie } : {} });

test("wallet sign-in creates a session the cookie resolves to", async () => {
  const s = await signed();
  const r = await verifySignIn(s.message, s.signature, HOST);
  assert.equal(r.address, account.address);
  assert.equal(sessionAddress(req(`${SESSION_COOKIE}=${r.token}`)), account.address.toLowerCase());
  assert.equal(sessionAddress(req(`${SESSION_COOKIE}=not-a-token`)), null);
  endSession(req(`${SESSION_COOKIE}=${r.token}`));
  assert.equal(sessionAddress(req(`${SESSION_COOKIE}=${r.token}`)), null, "logout ends it");
});

test("a nonce works once", async () => {
  const s = await signed();
  await verifySignIn(s.message, s.signature, HOST);
  await assert.rejects(verifySignIn(s.message, s.signature, HOST), (e: unknown) => e instanceof AuthError && /nonce/.test(e.message));
});

test("rejects: unknown nonce, another site, another chain, expired, wrong signer", async () => {
  const unknown = await signed({ nonce: "abcdefgh12345678" });
  await assert.rejects(verifySignIn(unknown.message, unknown.signature, HOST), /nonce/);
  const site = await signed({ domain: "evil.example" });
  await assert.rejects(verifySignIn(site.message, site.signature, HOST), /another site/);
  const chain = await signed({ chainId: 1 });
  await assert.rejects(verifySignIn(chain.message, chain.signature, HOST), /Arc testnet/);
  const old = await signed({ expired: true });
  await assert.rejects(verifySignIn(old.message, old.signature, HOST), /expired/);
  const s = await signed();
  const other = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(verifySignIn(s.message, await other.signMessage({ message: s.message }), HOST), /signature does not match/);
});
