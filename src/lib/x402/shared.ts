/**
 * x402 v2 over Arc testnet, `exact` scheme (EIP-3009 TransferWithAuthorization on USDC).
 * Headers carry base64-encoded JSON:
 *   PAYMENT-REQUIRED  (server -> client, with HTTP 402)
 *   PAYMENT-SIGNATURE (client -> server, the signed payment payload)
 *   PAYMENT-RESPONSE  (server -> client, settlement receipt)
 */
export const X402_VERSION = 2;
export const ARC_NETWORK = "eip155:5042002";
export const ARC_CHAIN_ID = 5042002;
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
export const USDC_EIP712 = { name: "USDC", version: "2" } as const;

export type PaymentRequirements = {
  scheme: "exact";
  network: string;
  amount: string; // atomic USDC units (6 decimals)
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; assetTransferMethod?: "eip3009" };
};

export type Resource = { url: string; description: string; mimeType: string };

export type PaymentRequired = {
  x402Version: number;
  error?: string;
  resource: Resource;
  accepts: PaymentRequirements[];
};

export type Authorization = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
};

export type PaymentPayload = {
  x402Version: number;
  resource: Resource;
  accepted: PaymentRequirements;
  payload: { signature: string; authorization: Authorization };
};

export type SettlementResponse = {
  success: boolean;
  payer?: string;
  transaction?: string;
  network?: string;
  amount?: string;
  errorReason?: string;
};

export const encodeHeader = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
export const decodeHeader = <T>(h: string): T => JSON.parse(Buffer.from(h, "base64").toString("utf8")) as T;

/** USD string like "0.01" -> atomic USDC string like "10000". */
export function usdToAtomic(usd: string): string {
  const [w, f = ""] = usd.split(".");
  return (BigInt(w || "0") * BigInt(1_000_000) + BigInt((f + "000000").slice(0, 6))).toString();
}
export const atomicToUsd = (a: string | bigint) => (Number(a) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
