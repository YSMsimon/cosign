/**
 * HTTP helpers for the backend API: typed errors → JSON responses, body parsing with zod,
 * and "prepared transactions" (calls a human signs in their own wallet). Server-only.
 */
import { ZodError, type z } from "zod";
import { encodeFunctionData, type Abi, type Address } from "viem";
import { AuthError } from "../auth";
import { PermError } from "../perm/permissions";
import { RulesError } from "../agent/rules";

export class HttpError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
  }
}
export const badRequest = (m: string, detail?: unknown) => new HttpError(400, m, detail);
export const forbidden = (m: string) => new HttpError(403, m);
export const notFound = (m = "not found") => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return Response.json({ error: e.message, ...(e.detail ? { detail: e.detail } : {}) }, { status: e.status });
  if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
  if (e instanceof PermError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof RulesError) return Response.json({ error: e.message }, { status: 400 });
  if (e instanceof ZodError) return Response.json({ error: "invalid request", detail: e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`) }, { status: 400 });
  console.error("[api] unexpected error:", e);
  return Response.json({ error: (e as Error)?.message ?? "internal error" }, { status: 500 });
}

export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown = {};
  const text = await req.text();
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw badRequest("body must be JSON");
    }
  }
  return schema.parse(raw);
}

/** A transaction for a person to sign in their own wallet (the server never holds human keys). */
export type PreparedTx = { chainId: number; to: Address; data: `0x${string}`; value: string; description: string };
export function prepare(to: Address, abi: Abi, functionName: string, args: readonly unknown[], description: string): PreparedTx {
  return { chainId: 5042002, to, data: encodeFunctionData({ abi, functionName, args } as never), value: "0x0", description };
}
/** A plain native USDC send (18 decimals on Arc). */
export function prepareTransfer(to: Address, amountWei: bigint, description: string): PreparedTx {
  return { chainId: 5042002, to, data: "0x", value: `0x${amountWei.toString(16)}`, description };
}
