/**
 * Buyer side of x402 for our agents: `paidFetch` calls a URL; if it answers 402, it checks the price
 * against the agent's policy, has Circle sign an EIP-3009 authorization with the agent's
 * developer-controlled wallet (no private key on our server), retries, and returns data + receipt.
 * Server-only.
 */
import { toHex } from "viem";
import { circle, wallet } from "../arc";
import {
  ARC_CHAIN_ID, ARC_NETWORK, X402_VERSION, atomicToUsd, decodeHeader, encodeHeader,
  type Authorization, type PaymentPayload, type PaymentRequired, type SettlementResponse,
} from "./shared";

export type PaidFetchPolicy = {
  maxPerCallUsd: number; // refuse anything pricier
  allowedHosts?: string[]; // seller allowlist (hostnames); undefined = allow all
};

export type PaidFetchResult = {
  status: number;
  data: unknown;
  paid: null | { amountUsd: string; payTo: string; transaction?: string; payer?: string };
};

export class PolicyRefusal extends Error {}

export async function paidFetch(agentRef: string, url: string, policy: PaidFetchPolicy, init?: RequestInit): Promise<PaidFetchResult> {
  const first = await fetch(url, init);
  if (first.status !== 402) return { status: first.status, data: await safeJson(first), paid: null };

  const header = first.headers.get("payment-required");
  const challenge: PaymentRequired = header ? decodeHeader(header) : ((await first.json()) as PaymentRequired);
  const req = challenge.accepts.find((r) => r.scheme === "exact" && r.network === ARC_NETWORK);
  if (!req) throw new PolicyRefusal(`no supported payment option (need exact on ${ARC_NETWORK})`);

  // ── policy check BEFORE anything is signed ──
  const host = new URL(url).hostname;
  if (policy.allowedHosts && !policy.allowedHosts.includes(host)) throw new PolicyRefusal(`seller ${host} is not on the allowlist`);
  const priceUsd = atomicToUsd(req.amount);
  if (Number(priceUsd) > policy.maxPerCallUsd) throw new PolicyRefusal(`price $${priceUsd} exceeds per-call cap $${policy.maxPerCallUsd}`);

  // ── sign EIP-3009 TransferWithAuthorization via Circle (agent's dev-controlled wallet) ──
  const agent = wallet(agentRef);
  const now = Math.floor(Date.now() / 1000);
  const authorization: Authorization = {
    from: agent.address,
    to: req.payTo,
    value: req.amount,
    validAfter: "0",
    validBefore: String(now + Math.max(60, req.maxTimeoutSeconds)),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const typedData = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    domain: { name: req.extra.name, version: req.extra.version, chainId: ARC_CHAIN_ID, verifyingContract: req.asset },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  };
  const signed = await circle().signTypedData({
    walletId: agent.id,
    data: JSON.stringify(typedData),
    memo: `x402: pay $${priceUsd} to ${host}`,
  });
  const signature = normalizeV(signed.data!.signature!);

  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    resource: challenge.resource,
    accepted: req,
    payload: { signature, authorization },
  };
  const second = await fetch(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), "PAYMENT-SIGNATURE": encodeHeader(payload) },
  });
  const receiptHeader = second.headers.get("payment-response");
  const receipt = receiptHeader ? decodeHeader<SettlementResponse>(receiptHeader) : undefined;
  return {
    status: second.status,
    data: await safeJson(second),
    paid: second.ok ? { amountUsd: priceUsd, payTo: req.payTo, transaction: receipt?.transaction, payer: receipt?.payer } : null,
  };
}

/** Facilitator requires v = 27/28; some signers return 0/1. */
function normalizeV(sig: string): string {
  const s = sig.startsWith("0x") ? sig.slice(2) : sig;
  if (s.length !== 130) return `0x${s}`;
  const v = parseInt(s.slice(128), 16);
  return v < 27 ? `0x${s.slice(0, 128)}${(v + 27).toString(16)}` : `0x${s}`;
}

async function safeJson(r: Response) {
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
