/**
 * Seller side of x402 for our demo paid APIs. Every 402 offers two rails on Arc testnet:
 *  1. Circle Gateway Nanopayments (GatewayWalletBatched): Circle's recommended seller default.
 *     Gas-free, sub-cent, batch-settled. Verified + settled by Circle Gateway (BatchFacilitatorClient),
 *     the same primitives as Circle's `createGatewayMiddleware`, adapted to Next.js route handlers.
 *  2. Vanilla x402 `exact` (EIP-3009 on USDC): settled per payment by Circle Facilitator Service
 *     (keyless trial: EIP-712 seller proof signed by the payTo key).
 * Server-only.
 */
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { keccak256, toBytes, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ARC_CHAIN_ID, ARC_NETWORK, USDC_ADDRESS, USDC_EIP712, X402_VERSION, decodeHeader, encodeHeader, usdToAtomic,
  type PaymentPayload, type PaymentRequired, type PaymentRequirements, type Resource, type SettlementResponse,
} from "./shared";

const FACILITATOR = "https://api.circle.com/v1/facilitator/x402";
const GATEWAY_API_TESTNET = "https://gateway-api-testnet.circle.com";
const ARC_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const GATEWAY_MIN_VALIDITY = 604_800; // from Gateway /supported (minValiditySeconds) for Arc testnet

const gateway = new BatchFacilitatorClient({ url: GATEWAY_API_TESTNET });

function sellerAccount() {
  const pk = process.env.SELLER_PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("SELLER_PRIVATE_KEY missing");
  return privateKeyToAccount(pk);
}

// ───────────── requirements ─────────────

export function gatewayRequirements(priceUsd: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: ARC_NETWORK,
    amount: usdToAtomic(priceUsd),
    asset: USDC_ADDRESS,
    payTo: sellerAccount().address,
    maxTimeoutSeconds: GATEWAY_MIN_VALIDITY + 100,
    extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: ARC_GATEWAY_WALLET },
  };
}

export function vanillaRequirements(priceUsd: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: ARC_NETWORK,
    amount: usdToAtomic(priceUsd),
    asset: USDC_ADDRESS,
    payTo: sellerAccount().address,
    maxTimeoutSeconds: 60,
    extra: { ...USDC_EIP712, assetTransferMethod: "eip3009" },
  };
}

// ───────────── vanilla settlement (Circle Facilitator Service, keyless) ─────────────

async function sellerProof(purpose: "verify" | "settle" | "status", method: string, body: string) {
  const account = sellerAccount();
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 300;
  const signature = await account.signTypedData({
    domain: { name: "Circle Facilitator Seller Request", version: "1", chainId: ARC_CHAIN_ID },
    types: {
      SellerRequest: [
        { name: "purpose", type: "string" },
        { name: "method", type: "string" },
        { name: "bodyHash", type: "bytes32" },
        { name: "network", type: "string" },
        { name: "payTo", type: "address" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint64" },
        { name: "expiresAt", type: "uint64" },
      ],
    },
    primaryType: "SellerRequest",
    message: {
      purpose,
      method: method.toUpperCase(),
      bodyHash: keccak256(toBytes(body)),
      network: ARC_NETWORK,
      payTo: account.address,
      nonce,
      issuedAt: BigInt(issuedAt),
      expiresAt: BigInt(expiresAt),
    },
  });
  const envelope = { version: 1, signature, network: ARC_NETWORK, payTo: account.address, nonce, issuedAt, expiresAt };
  return Buffer.from(JSON.stringify(envelope)).toString("base64url");
}

async function settleVanilla(paymentPayload: PaymentPayload, req: PaymentRequirements): Promise<SettlementResponse> {
  const { extra, ...rest } = req;
  const body = JSON.stringify({
    x402Version: X402_VERSION,
    paymentPayload,
    paymentRequirements: { ...rest, extra: { name: extra.name, version: extra.version } },
  });
  const res = await fetch(`${FACILITATOR}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Facilitator-Seller-Proof": await sellerProof("settle", "POST", body) },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as SettlementResponse & { message?: string };
  if (!res.ok) return { success: false, errorReason: `facilitator_${res.status}: ${json.message ?? JSON.stringify(json)}` };
  return json;
}

// ───────────── gateway settlement (Circle Gateway, batched) ─────────────

async function settleGateway(paymentPayload: PaymentPayload, req: PaymentRequirements): Promise<SettlementResponse> {
  const v = (await gateway.verify(paymentPayload as never, req as never)) as { isValid?: boolean; invalidReason?: string };
  if (!v.isValid) return { success: false, errorReason: `gateway_verify: ${v.invalidReason ?? "invalid"}` };
  const s = (await gateway.settle(paymentPayload as never, req as never)) as SettlementResponse & { errorReason?: string };
  return s;
}

// ───────────── route guard ─────────────

/**
 * Guard a route handler with an x402 price. Returns either a 402 Response to send back,
 * or the settlement receipt once the buyer has paid (on either rail).
 */
export async function requirePayment(
  req: Request,
  opts: { priceUsd: string; description: string },
): Promise<
  | { paid: false; response: Response }
  | { paid: true; rail: "gateway" | "vanilla"; receipt: SettlementResponse; headers: HeadersInit }
> {
  const gatewayReq = gatewayRequirements(opts.priceUsd);
  const vanillaReq = vanillaRequirements(opts.priceUsd);
  const resource: Resource = { url: req.url, description: opts.description, mimeType: "application/json" };
  const challenge = (error?: string) => {
    const body: PaymentRequired = { x402Version: X402_VERSION, error, resource, accepts: [gatewayReq, vanillaReq] };
    return new Response(JSON.stringify(body), {
      status: 402,
      headers: { "Content-Type": "application/json", "PAYMENT-REQUIRED": encodeHeader(body) },
    });
  };

  const header = req.headers.get("payment-signature");
  if (!header) return { paid: false, response: challenge("payment required") };

  let payload: PaymentPayload;
  try {
    payload = decodeHeader<PaymentPayload>(header);
  } catch {
    return { paid: false, response: challenge("malformed PAYMENT-SIGNATURE") };
  }

  const rail: "gateway" | "vanilla" = payload.accepted?.extra?.name === "GatewayWalletBatched" ? "gateway" : "vanilla";
  const expected = rail === "gateway" ? gatewayReq : vanillaReq;
  const a = payload.payload?.authorization;
  if (
    !a ||
    payload.accepted?.network !== ARC_NETWORK ||
    payload.accepted?.payTo?.toLowerCase() !== expected.payTo.toLowerCase() ||
    BigInt(a.value) < BigInt(expected.amount)
  ) {
    return { paid: false, response: challenge("payment does not match requirements") };
  }

  const receipt = rail === "gateway" ? await settleGateway(payload, expected) : await settleVanilla(payload, expected);
  if (!receipt.success) return { paid: false, response: challenge(`settlement failed: ${receipt.errorReason}`) };
  return { paid: true, rail, receipt, headers: { "PAYMENT-RESPONSE": encodeHeader(receipt) } };
}
