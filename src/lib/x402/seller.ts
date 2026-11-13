/**
 * Seller side of x402: protect a route with a price, settle through Circle Facilitator Service
 * (keyless trial on Arc testnet: authenticated by an EIP-712 "seller proof" signed by the payTo key).
 * Server-only.
 */
import { keccak256, toBytes, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ARC_CHAIN_ID, ARC_NETWORK, USDC_ADDRESS, USDC_EIP712, X402_VERSION, decodeHeader, encodeHeader, usdToAtomic,
  type PaymentPayload, type PaymentRequired, type PaymentRequirements, type Resource, type SettlementResponse,
} from "./shared";

const FACILITATOR = "https://api.circle.com/v1/facilitator/x402";

function sellerAccount() {
  const pk = process.env.SELLER_PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("SELLER_PRIVATE_KEY missing");
  return privateKeyToAccount(pk);
}

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

export function requirementsFor(priceUsd: string): PaymentRequirements {
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

async function settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettlementResponse> {
  const { extra, ...req } = paymentRequirements;
  const body = JSON.stringify({
    x402Version: X402_VERSION,
    paymentPayload,
    paymentRequirements: { ...req, extra: { name: extra.name, version: extra.version } },
  });
  const res = await fetch(`${FACILITATOR}/settle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Facilitator-Seller-Proof": await sellerProof("settle", "POST", body),
    },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as SettlementResponse & { message?: string };
  if (!res.ok) return { success: false, errorReason: `facilitator_${res.status}: ${json.message ?? JSON.stringify(json)}` };
  return json;
}

/**
 * Guard a route handler with an x402 price. Returns either a 402 Response to send back,
 * or the settlement receipt once the buyer has paid.
 */
export async function requirePayment(
  req: Request,
  opts: { priceUsd: string; description: string },
): Promise<{ paid: false; response: Response } | { paid: true; receipt: SettlementResponse; headers: HeadersInit }> {
  const requirements = requirementsFor(opts.priceUsd);
  const resource: Resource = { url: req.url, description: opts.description, mimeType: "application/json" };
  const challenge = (error?: string) => {
    const body: PaymentRequired = { x402Version: X402_VERSION, error, resource, accepts: [requirements] };
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
  const a = payload.payload?.authorization;
  if (
    !a ||
    payload.accepted?.scheme !== "exact" ||
    payload.accepted?.network !== ARC_NETWORK ||
    a.to.toLowerCase() !== requirements.payTo.toLowerCase() ||
    BigInt(a.value) < BigInt(requirements.amount)
  ) {
    return { paid: false, response: challenge("payment does not match requirements") };
  }

  const receipt = await settle(payload, requirements);
  if (!receipt.success) return { paid: false, response: challenge(`settlement failed: ${receipt.errorReason}`) };
  return { paid: true, receipt, headers: { "PAYMENT-RESPONSE": encodeHeader(receipt) } };
}
