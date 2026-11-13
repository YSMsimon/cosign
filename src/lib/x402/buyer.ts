/**
 * Buyer side of x402 for our agents. `paidFetch` calls a URL; on 402 it picks a payment rail,
 * checks the agent's policy BEFORE anything is signed, has Circle sign with the agent's
 * developer-controlled EOA (no private key on our server), retries, and returns data + receipt.
 *
 * Rails (Arc testnet):
 *  - "gateway": Circle Gateway Nanopayments (GatewayWalletBatched): gas-free, sub-cent, batched.
 *    Preferred when offered and the agent has Gateway balance. Built with Circle's BatchEvmScheme.
 *  - "vanilla": plain x402 `exact` (EIP-3009 on the USDC contract), settled per payment.
 * Server-only.
 */
import { toHex } from "viem";
import { circle, wallet } from "../arc";
import { sellerAllowed } from "../agent/rules";
import { batchSchemeFor, gatewayBalance } from "./gateway";
import {
  ARC_CHAIN_ID, ARC_NETWORK, X402_VERSION, atomicToUsd, decodeHeader, encodeHeader,
  type Authorization, type PaymentPayload, type PaymentRequired, type PaymentRequirements, type SettlementResponse,
} from "./shared";

export type PaidFetchPolicy = {
  maxPerCallUsd: number; // refuse anything pricier
  allowedHosts?: string[]; // seller allowlist ("host[:port][/path]", see sellerAllowed); undefined = allow all
  preferGateway?: boolean; // default true
  /** Last check before signing, with the real price (budgets, speed limit, ask-a-person). Throw PolicyRefusal / NeedsApproval to stop. */
  beforeSign?: (q: { priceUsd: number; host: string; payTo: string; url: string }) => Promise<void> | void;
};

export type PaidFetchResult = {
  status: number;
  data: unknown;
  paid: null | {
    rail: "gateway" | "vanilla";
    amountUsd: string;
    payTo: string;
    transaction?: string; // vanilla: settled tx hash; gateway: settles later in a batch
    nonce?: string; // EIP-3009 nonce (lookup key for Gateway transfer status)
    receipt?: SettlementResponse;
  };
};

export class PolicyRefusal extends Error {}
/** The purchase is above the agent's ask-a-person line: a member must OK it first. */
export class NeedsApproval extends PolicyRefusal {
  constructor(public requestId: string, message: string) {
    super(message);
  }
}

const isGateway = (r: PaymentRequirements) => r.network === ARC_NETWORK && r.extra?.name === "GatewayWalletBatched";
const isVanilla = (r: PaymentRequirements) => r.network === ARC_NETWORK && r.scheme === "exact" && !isGateway(r);

export async function paidFetch(agentRef: string, url: string, policy: PaidFetchPolicy, init?: RequestInit): Promise<PaidFetchResult> {
  if (policy.allowedHosts) {
    const m = sellerAllowed(policy.allowedHosts, url);
    if (!m.ok) throw new PolicyRefusal(m.reason);
  }
  // Redirects are returned, not followed: the agent may call the new URL, which is checked again.
  const first = await fetch(url, { ...init, redirect: "manual" });
  if (first.status >= 300 && first.status < 400) return { status: first.status, data: { redirect: first.headers.get("location") }, paid: null };
  if (first.status !== 402) return { status: first.status, data: await safeJson(first), paid: null };

  const header = first.headers.get("payment-required");
  const challenge: PaymentRequired = header ? decodeHeader(header) : ((await first.json()) as PaymentRequired);
  const gatewayOpt = challenge.accepts.find(isGateway);
  const vanillaOpt = challenge.accepts.find(isVanilla);
  if (!gatewayOpt && !vanillaOpt) throw new PolicyRefusal(`no supported payment option on ${ARC_NETWORK}`);

  // ── policy check BEFORE anything is signed ──
  const host = new URL(url).hostname;

  const agent = wallet(agentRef);
  let rail: "gateway" | "vanilla";
  let req: PaymentRequirements;
  if (gatewayOpt && policy.preferGateway !== false && (await gatewayBalance(agent.address)) >= Number(atomicToUsd(gatewayOpt.amount))) {
    rail = "gateway";
    req = gatewayOpt;
  } else if (vanillaOpt) {
    rail = "vanilla";
    req = vanillaOpt;
  } else {
    throw new PolicyRefusal("seller only accepts Gateway nanopayments and the agent's Gateway balance is too low; deposit first");
  }
  const priceUsd = atomicToUsd(req.amount);
  if (Number(priceUsd) > policy.maxPerCallUsd) throw new PolicyRefusal(`price $${priceUsd} exceeds per-call cap $${policy.maxPerCallUsd}`);
  await policy.beforeSign?.({ priceUsd: Number(priceUsd), host, payTo: req.payTo, url });

  // ── sign ──
  let headerValue: string;
  let nonce: string;
  if (rail === "gateway") {
    const p = await batchSchemeFor(agentRef).createPaymentPayload(challenge.x402Version, req as never);
    nonce = (p.payload as { authorization?: { nonce?: string } }).authorization?.nonce ?? "";
    headerValue = encodeHeader({ ...p, accepted: req, resource: challenge.resource });
  } else {
    const authorization = await signVanilla(agent.id, agent.address, req, host, priceUsd);
    nonce = authorization.auth.nonce;
    const payload: PaymentPayload = {
      x402Version: X402_VERSION,
      resource: challenge.resource,
      accepted: req,
      payload: { signature: authorization.signature, authorization: authorization.auth },
    };
    headerValue = encodeHeader(payload);
  }

  const second = await fetch(url, { ...init, redirect: "manual", headers: { ...(init?.headers ?? {}), "PAYMENT-SIGNATURE": headerValue } });
  const receiptHeader = second.headers.get("payment-response");
  const receipt = receiptHeader ? decodeHeader<SettlementResponse>(receiptHeader) : undefined;
  return {
    status: second.status,
    data: await safeJson(second),
    paid: second.ok
      ? { rail, amountUsd: priceUsd, payTo: req.payTo, transaction: receipt?.transaction || undefined, nonce, receipt }
      : null,
  };
}

async function signVanilla(walletId: string, from: string, req: PaymentRequirements, host: string, priceUsd: string) {
  const now = Math.floor(Date.now() / 1000);
  const auth: Authorization = {
    from,
    to: req.payTo,
    value: req.amount,
    validAfter: "0",
    validBefore: String(now + Math.max(60, Math.min(req.maxTimeoutSeconds, 3600))),
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
    message: auth,
  };
  const signed = await circle().signTypedData({ walletId, data: JSON.stringify(typedData), memo: `x402: pay $${priceUsd} to ${host}` });
  return { auth, signature: normalizeV(signed.data!.signature!) };
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
