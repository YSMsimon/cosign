/**
 * Wallet sign-in (Sign-In with Ethereum, EIP-4361) and cookie sessions. Server-only.
 *   1. GET nonce → the browser builds a SIWE message with it and the wallet signs it
 *   2. POST message + signature → we check domain, nonce (one use, 10 min), chain, time and the
 *      signature, then set an httpOnly cookie holding a random token (we store only its hash).
 * Wallet address = identity. What you may do comes from your member record in each workspace.
 */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getAddress, verifyMessage, type Address, type Hex } from "viem";
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { db, schema } from "../db";
import { newToken, sha256 } from "../server/util";

export const SESSION_COOKIE = "cosign_session";
const SESSION_DAYS = 7;
const NONCE_MINUTES = 10;
export const ARC_TESTNET_CHAIN_ID = 5042002;

export class AuthError extends Error {
  constructor(message: string, public status = 401) {
    super(message);
  }
}

export function createNonce(): string {
  const nonce = generateSiweNonce();
  db().insert(schema.authNonces).values({ nonce, createdAt: new Date().toISOString() }).run();
  return nonce;
}

/** Verify a signed SIWE message for this host; returns the session token to put in the cookie. */
export async function verifySignIn(message: string, signature: string, host: string): Promise<{ address: Address; token: string; expiresAt: string }> {
  const parsed = parseSiweMessage(message);
  if (!parsed.address || !parsed.nonce) throw new AuthError("malformed sign-in message", 400);
  if (parsed.chainId !== ARC_TESTNET_CHAIN_ID) throw new AuthError(`sign in on Arc testnet (chain ${ARC_TESTNET_CHAIN_ID})`, 400);
  if (!validateSiweMessage({ message: parsed, domain: host, nonce: parsed.nonce, time: new Date() })) {
    throw new AuthError("sign-in message is for another site, expired, or not yet valid");
  }
  const ok = await verifyMessage({ address: parsed.address, message, signature: signature as Hex }).catch(() => false);
  if (!ok) throw new AuthError("signature does not match the address");

  // one-time nonce issued by us in the last 10 minutes
  const cutoff = new Date(Date.now() - NONCE_MINUTES * 60_000).toISOString();
  const used = db()
    .update(schema.authNonces)
    .set({ usedAt: new Date().toISOString() })
    .where(and(eq(schema.authNonces.nonce, parsed.nonce), isNull(schema.authNonces.usedAt), gt(schema.authNonces.createdAt, cutoff)))
    .returning()
    .all();
  if (!used.length) throw new AuthError("sign-in nonce is unknown, used or expired");

  const address = getAddress(parsed.address);
  const lower = address.toLowerCase();
  const now = new Date().toISOString();
  db()
    .insert(schema.users)
    .values({ address: lower, createdAt: now, lastLoginAt: now })
    .onConflictDoUpdate({ target: schema.users.address, set: { lastLoginAt: now } })
    .run();
  // invited addresses get access the first time they sign in
  db().update(schema.members).set({ joinedAt: now }).where(and(eq(schema.members.address, lower), isNull(schema.members.joinedAt))).run();

  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  db().insert(schema.authSessions).values({ tokenHash: sha256(token), address: lower, createdAt: now, expiresAt }).run();
  return { address, token, expiresAt };
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** The signed-in wallet for this request (lowercase), or null. */
export function sessionAddress(req: Request): string | null {
  const token = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
  if (!token) return null;
  const row = db()
    .select()
    .from(schema.authSessions)
    .where(and(eq(schema.authSessions.tokenHash, sha256(token)), gt(schema.authSessions.expiresAt, new Date().toISOString())))
    .get();
  return row?.address ?? null;
}

export function endSession(req: Request) {
  const token = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
  if (token) db().delete(schema.authSessions).where(eq(schema.authSessions.tokenHash, sha256(token))).run();
}

export function sessionCookie(token: string, expiresAt: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secure ? "; Secure" : ""}`;
}
export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;

/** Housekeeping: drop expired sessions and old nonces. */
export function pruneAuth() {
  const now = new Date().toISOString();
  db().delete(schema.authSessions).where(sql`${schema.authSessions.expiresAt} < ${now}`).run();
  db().delete(schema.authNonces).where(sql`${schema.authNonces.createdAt} < ${new Date(Date.now() - 86_400_000).toISOString()}`).run();
}
