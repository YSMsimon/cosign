/**
 * What an agent may do (abilities) and the seven wallet controls (pure: no database, no network).
 * Stored per agent in SQLite; checked by our server before Circle signs anything. Onchain, the
 * contract still decides who may draft, the weekly petty-cash ceiling, cosigning and pause.
 */
import { isAddress, type Address } from "viem";
import type { AgentPolicy } from "./tools";

export type Abilities = {
  sandbox: boolean; // its own microVM (files, scripts)
  buy: boolean; // pay for API data from its own wallet (x402 / Gateway nanopayments)
  draft: boolean; // draft treasury payments (onchain proposer role); a human always cosigns
  pettyCash: boolean; // draw petty cash from the treasury (onchain weekly allowance)
};

export type Limits = { perPayment: number | null; daily: number | null; weekly: number | null; monthly: number | null };

export type Controls = {
  purchases: Limits; // 1 + 2: per-payment cap and rolling budgets for the agent's own purchases
  drafts: Limits; // 1 + 2: the same for treasury drafts
  maxPaymentsPerHour: number | null; // 3: speed limit across purchases and drafts
  allowedSellers: string[]; // 4: sellers it may call, "host[:port][/path]" (everything else blocked)
  allowedPayees: string[]; // 4: addresses it may draft to (everything else blocked)
  askAboveUsd: number | null; // 5: purchases above this wait for a member's OK
  topUpMaxUsd: number | null; // per petty-cash request (the onchain weekly allowance is the hard ceiling)
  pettyCashPerWeekUsd: number | null; // the onchain weekly allowance an approver should set
  allowedSwapTokens: string[]; // tokens its own wallet may swap USDC into (Circle App Kit; on Arc testnet: EURC)
  maxSlippageBps: number | null; // the most a swap's price may move, in basis points (300 = 3%)
  allowedBridgeChains: string[]; // chains its own wallet may bridge USDC to over CCTP (App Kit names, e.g. Base_Sepolia)
  earnVaults: string[]; // Earn vault addresses its own wallet may deposit into
  borrowMarkets: string[]; // borrow market ids it may look up (quotes only: App Kit can't borrow from an EOA wallet)
  frozen: boolean; // 6: money abilities off now
  expiresAt: string | null; // 6: money abilities switch off after this time (ISO)
};

export type AgentRules = { abilities: Abilities; controls: Controls };

export const PRESETS: Record<"readonly" | "buyer" | "clerk", Abilities> = {
  readonly: { sandbox: true, buy: false, draft: false, pettyCash: false },
  buyer: { sandbox: true, buy: true, draft: false, pettyCash: false },
  clerk: { sandbox: true, buy: true, draft: true, pettyCash: true },
};

export const DEFAULT_CONTROLS: Controls = {
  purchases: { perPayment: 0.05, daily: 0.5, weekly: 2, monthly: 5 },
  drafts: { perPayment: 5, daily: 20, weekly: 50, monthly: 100 },
  maxPaymentsPerHour: 10,
  allowedSellers: [],
  allowedPayees: [],
  askAboveUsd: null,
  topUpMaxUsd: 1,
  pettyCashPerWeekUsd: 2,
  allowedSwapTokens: [],
  maxSlippageBps: 300,
  allowedBridgeChains: [],
  earnVaults: [],
  borrowMarkets: [],
  frozen: false,
  expiresAt: null,
};

export class RulesError extends Error {}

/** Tokens Circle App Kit swaps on Arc (USDC is what the agent pays with). */
// what App Kit can actually route from USDC on Arc testnet (cirBTC: "No route available", checked 2026-11-15)
export const SWAP_TOKENS = ["EURC"] as const;

const nn = (v: unknown, field: string): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new RulesError(`${field} must be a number ≥ 0 or null`);
  return n;
};

function limits(v: unknown, field: string, base: Limits): Limits {
  const o = (v ?? {}) as Partial<Limits>;
  const l: Limits = {
    perPayment: "perPayment" in o ? nn(o.perPayment, `${field}.perPayment`) : base.perPayment,
    daily: "daily" in o ? nn(o.daily, `${field}.daily`) : base.daily,
    weekly: "weekly" in o ? nn(o.weekly, `${field}.weekly`) : base.weekly,
    monthly: "monthly" in o ? nn(o.monthly, `${field}.monthly`) : base.monthly,
  };
  // caps must nest: per-payment ≤ daily ≤ weekly ≤ monthly (unset ones are skipped)
  const chain = [l.perPayment, l.daily, l.weekly, l.monthly];
  let prev: number | null = null;
  for (const x of chain) {
    if (x === null) continue;
    if (prev !== null && x < prev) throw new RulesError(`${field}: caps must nest (per-payment ≤ daily ≤ weekly ≤ monthly)`);
    prev = x;
  }
  return l;
}

const SELLER_RE = /^[a-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** "LocalHost:3000/api/sellers/" -> "localhost:3000/api/sellers" (host lowercased, path kept, no trailing slash). */
export function normalizeSeller(entry: string): string {
  const e = entry.trim().replace(/^https?:\/\//i, "");
  const i = e.indexOf("/");
  const host = (i < 0 ? e : e.slice(0, i)).toLowerCase();
  const path = i < 0 ? "" : e.slice(i).replace(/\/+$/, "");
  return host + path;
}

/**
 * Is this URL on the seller allowlist? An entry names a host, optionally a port and a path prefix:
 * "x402.quicknode.com" (default port only), "localhost:3000" (that port only),
 * "localhost:3000/api/sellers" (that port, under that path). A bare host never matches another port,
 * so allowing one local service never opens the rest of the machine. Plain http only for loopback.
 */
export function sellerAllowed(entries: string[], url: string): { ok: true } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (u.username || u.password) return { ok: false, reason: "URLs with credentials are not allowed" };
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) return { ok: false, reason: "only https URLs (http only for local demo APIs)" };
  const host = u.host.toLowerCase();
  for (const raw of entries) {
    const e = normalizeSeller(raw);
    const i = e.indexOf("/");
    const eHost = i < 0 ? e : e.slice(0, i);
    const ePath = i < 0 ? "" : e.slice(i);
    if (eHost !== host) continue;
    if (!ePath || u.pathname === ePath || u.pathname.startsWith(`${ePath}/`)) return { ok: true };
  }
  return { ok: false, reason: `${host}${u.pathname} is not on this agent's seller allowlist` };
}

/** Merge a partial update onto current controls and validate the result. */
export function mergeControls(current: Controls, patch: unknown): Controls {
  const p = (patch ?? {}) as Partial<Controls>;
  const hosts = (v: unknown) => {
    if (!Array.isArray(v)) throw new RulesError("allowedSellers must be a list of sellers (host[:port][/path])");
    return [...new Set(v.map((h) => normalizeSeller(String(h))))].filter((h) => {
      if (!SELLER_RE.test(h)) throw new RulesError(`bad seller "${h}" (use host, host:port or host:port/path)`);
      return true;
    });
  };
  const addrs = (v: unknown) => {
    if (!Array.isArray(v)) throw new RulesError("allowedPayees must be a list of addresses");
    return [...new Set(v.map((a) => String(a).trim().toLowerCase()))].filter((a) => {
      if (!isAddress(a)) throw new RulesError(`bad payee address "${a}"`);
      return true;
    });
  };
  const tokens = (v: unknown) => {
    if (!Array.isArray(v)) throw new RulesError("allowedSwapTokens must be a list of tokens");
    const named = v.map((raw) => {
      const t = String(raw).trim();
      const known = SWAP_TOKENS.find((x) => x.toLowerCase() === t.toLowerCase());
      if (!known) throw new RulesError(`can't swap to "${t}" (on Arc: ${SWAP_TOKENS.join(", ")})`);
      return known as string;
    });
    return [...new Set(named)]; // normalise first, then drop repeats ("eurc" and "EURC" are one token)
  };
  const names = (v: unknown, field: string, re: RegExp) => {
    if (!Array.isArray(v)) throw new RulesError(`${field} must be a list`);
    const xs = v.map((x) => String(x).trim());
    for (const x of xs) if (!re.test(x)) throw new RulesError(`bad ${field} entry "${x}"`);
    return [...new Set(xs)];
  };
  let expiresAt = current.expiresAt;
  if ("expiresAt" in p) {
    if (p.expiresAt === null) expiresAt = null;
    else {
      const t = Date.parse(String(p.expiresAt));
      if (!Number.isFinite(t)) throw new RulesError("expiresAt must be an ISO date or null");
      expiresAt = new Date(t).toISOString();
    }
  }
  return {
    purchases: limits(p.purchases, "purchases", current.purchases),
    drafts: limits(p.drafts, "drafts", current.drafts),
    maxPaymentsPerHour: "maxPaymentsPerHour" in p ? nn(p.maxPaymentsPerHour, "maxPaymentsPerHour") : current.maxPaymentsPerHour,
    allowedSellers: "allowedSellers" in p ? hosts(p.allowedSellers) : current.allowedSellers,
    allowedPayees: "allowedPayees" in p ? addrs(p.allowedPayees) : current.allowedPayees,
    askAboveUsd: "askAboveUsd" in p ? nn(p.askAboveUsd, "askAboveUsd") : current.askAboveUsd,
    topUpMaxUsd: "topUpMaxUsd" in p ? nn(p.topUpMaxUsd, "topUpMaxUsd") : current.topUpMaxUsd,
    pettyCashPerWeekUsd: "pettyCashPerWeekUsd" in p ? nn(p.pettyCashPerWeekUsd, "pettyCashPerWeekUsd") : current.pettyCashPerWeekUsd,
    allowedSwapTokens: "allowedSwapTokens" in p ? tokens(p.allowedSwapTokens) : (current.allowedSwapTokens ?? []),
    maxSlippageBps: "maxSlippageBps" in p ? nn(p.maxSlippageBps, "maxSlippageBps") : (current.maxSlippageBps ?? DEFAULT_CONTROLS.maxSlippageBps),
    allowedBridgeChains: "allowedBridgeChains" in p ? names(p.allowedBridgeChains, "allowedBridgeChains", /^[A-Za-z][A-Za-z0-9_]{1,40}$/) : (current.allowedBridgeChains ?? []),
    earnVaults: "earnVaults" in p ? names(p.earnVaults, "earnVaults", /^0x[0-9a-fA-F]{40}$/).map((x) => x.toLowerCase()) : (current.earnVaults ?? []),
    borrowMarkets: "borrowMarkets" in p ? names(p.borrowMarkets, "borrowMarkets", /^0x[0-9a-fA-F]{64}$/).map((x) => x.toLowerCase()) : (current.borrowMarkets ?? []),
    frozen: "frozen" in p ? Boolean(p.frozen) : current.frozen,
    expiresAt,
  };
}

export function mergeAbilities(current: Abilities, patch: unknown): Abilities {
  const p = (patch ?? {}) as Partial<Abilities>;
  const b = (k: keyof Abilities) => (k in p ? Boolean(p[k]) : current[k]);
  return { sandbox: b("sandbox"), buy: b("buy"), draft: b("draft"), pettyCash: b("pettyCash") };
}

/** Does going from `a` to `b` give the agent more room? (Loosening needs All access.) */
export function loosens(a: AgentRules, b: AgentRules): string[] {
  const why: string[] = [];
  for (const k of ["sandbox", "buy", "draft", "pettyCash"] as const) if (!a.abilities[k] && b.abilities[k]) why.push(`turns on ${k}`);
  const cap = (x: number | null, y: number | null, name: string) => {
    if (x !== null && (y === null || y > x)) why.push(`raises ${name}`);
  };
  for (const kind of ["purchases", "drafts"] as const)
    for (const k of ["perPayment", "daily", "weekly", "monthly"] as const) cap(a.controls[kind][k], b.controls[kind][k], `${kind}.${k}`);
  cap(a.controls.maxPaymentsPerHour, b.controls.maxPaymentsPerHour, "maxPaymentsPerHour");
  cap(a.controls.askAboveUsd, b.controls.askAboveUsd, "askAboveUsd");
  cap(a.controls.topUpMaxUsd, b.controls.topUpMaxUsd, "topUpMaxUsd");
  cap(a.controls.pettyCashPerWeekUsd, b.controls.pettyCashPerWeekUsd, "pettyCashPerWeekUsd");
  cap(a.controls.maxSlippageBps ?? 300, b.controls.maxSlippageBps ?? 300, "maxSlippageBps");
  if ((b.controls.allowedSwapTokens ?? []).some((t) => !(a.controls.allowedSwapTokens ?? []).includes(t))) why.push("adds swap tokens");
  const adds = (k: "allowedBridgeChains" | "earnVaults" | "borrowMarkets", what: string) => {
    if ((b.controls[k] ?? []).some((x) => !(a.controls[k] ?? []).includes(x))) why.push(`adds ${what}`);
  };
  adds("allowedBridgeChains", "bridge chains");
  adds("earnVaults", "earn vaults");
  adds("borrowMarkets", "borrow markets");
  if (b.controls.allowedSellers.some((h) => !a.controls.allowedSellers.includes(h))) why.push("adds sellers");
  if (b.controls.allowedPayees.some((x) => !a.controls.allowedPayees.includes(x))) why.push("adds payees");
  if (a.controls.frozen && !b.controls.frozen) why.push("unfreezes");
  if (a.controls.expiresAt && (!b.controls.expiresAt || b.controls.expiresAt > a.controls.expiresAt)) why.push("extends the end date");
  return why;
}

/** Money abilities are live only when not frozen and before the end date. */
export function moneyLive(c: Controls, now = Date.now()): boolean {
  return !c.frozen && (!c.expiresAt || Date.parse(c.expiresAt) > now);
}

/** The abilities in force for one run: the agent's, minus money when frozen/expired or when the person asking may not request payments. */
export function effectiveAbilities(r: AgentRules, opts: { canRequestPayments: boolean; now?: number }): Abilities {
  const money = moneyLive(r.controls, opts.now) && opts.canRequestPayments;
  return { sandbox: r.abilities.sandbox, buy: r.abilities.buy && money, draft: r.abilities.draft && money, pettyCash: r.abilities.pettyCash && money };
}

/** Old script profiles (AgentPolicy) expressed as rules, so scripts and saved agents share one check path. */
export function rulesFromPolicy(p: AgentPolicy): AgentRules {
  return {
    abilities: {
      sandbox: p.sandbox,
      buy: p.maxPerCallUsd > 0 && p.allowedHosts.length > 0,
      draft: p.maxProposalUsd > 0 && p.allowedPayees.length > 0,
      pettyCash: p.maxTopUpUsd > 0,
    },
    controls: {
      ...DEFAULT_CONTROLS,
      purchases: { perPayment: p.maxPerCallUsd, daily: null, weekly: null, monthly: null },
      drafts: { perPayment: p.maxProposalUsd, daily: null, weekly: null, monthly: null },
      maxPaymentsPerHour: null,
      allowedSellers: p.allowedHosts.map((h) => h.toLowerCase()),
      allowedPayees: p.allowedPayees.map((a) => (a as Address).toLowerCase()),
      topUpMaxUsd: p.maxTopUpUsd,
      pettyCashPerWeekUsd: null,
      allowedSwapTokens: [],
      maxSlippageBps: 300,
      allowedBridgeChains: [],
      earnVaults: [],
      borrowMarkets: [],
    },
  };
}

/** policy.md written into the agent's read-only context folder: the agent reads its own rules. */
export function rulesMarkdown(name: string, r: AgentRules, payees: { name: string; address: string }[]): string {
  const c = r.controls;
  const usd = (x: number | null) => (x === null ? "no limit" : `$${x}`);
  const lines = [`# ${name}: rules (set by the company; you cannot change them)`, ""];
  lines.push("- Agents draft; humans cosign. Never claim a payment is done until it is approved.");
  lines.push(`- Abilities: ${(["buy", "draft", "pettyCash", "sandbox"] as const).filter((k) => r.abilities[k]).join(", ") || "read-only"}.`);
  if (!moneyLive(c)) lines.push(`- Money abilities are OFF right now (${c.frozen ? "frozen" : "past the end date"}).`);
  if (r.abilities.buy) {
    lines.push(`- API purchases: per payment ${usd(c.purchases.perPayment)}, per day ${usd(c.purchases.daily)}, per week ${usd(c.purchases.weekly)}, per month ${usd(c.purchases.monthly)}.`);
    const k = c.allowedSellers.length;
    lines.push(
      k
        ? `- Paid APIs: ${k} allowed seller${k === 1 ? "" : "s"}; call list_allowed (list='sellers') for them, their services and prices. Nothing else is reachable with paid_fetch.`
        : "- Paid APIs: no allowed sellers yet.",
    );
    if (c.askAboveUsd !== null) lines.push(`- Purchases above $${c.askAboveUsd} wait for a member's OK.`);
    lines.push("- From your own wallet you may also send USDC to a saved payee (send_usdc); it counts as a purchase for every limit above.");
    const sw = c.allowedSwapTokens ?? [];
    lines.push(
      sw.length
        ? `- Swaps: your own wallet may swap USDC into ${sw.join(", ")} (swap), with the price moving at most ${(c.maxSlippageBps ?? 300) / 100}%; the USDC counts as a purchase for every limit above, and the tokens come back to your wallet.`
        : "- Swaps: none allowed.",
    );
    const br = c.allowedBridgeChains ?? [];
    lines.push(br.length ? `- Bridge (bridge): USDC to a saved payee or your own wallet on ${br.join(", ")}; amount plus fees count as a purchase.` : "- Bridge: no chains allowed.");
    lines.push("- Gateway (gateway_deposit): you may move USDC from your wallet into your own Gateway balance (what nanopayments spend); it counts as a purchase.");
    lines.push((c.earnVaults ?? []).length ? "- Earn (earn): deposit into or withdraw from your allowed Earn vaults; deposits count as a purchase." : "- Earn: no vaults allowed.");
    lines.push((c.borrowMarkets ?? []).length ? "- Borrow (borrow): market list and quotes only; this wallet can't take a loan." : "- Borrow: not allowed.");
  }
  lines.push("- If the treasury is too short for what the company needs, ask a person to add funds with request_funds; you never buy crypto yourself.");
  if (r.abilities.draft) {
    lines.push(`- Drafts: per payment ${usd(c.drafts.perPayment)}, per day ${usd(c.drafts.daily)}, per week ${usd(c.drafts.weekly)}, per month ${usd(c.drafts.monthly)}.`);
    const n = payees.length;
    lines.push(
      n
        ? `- Payees you may draft to: ${n} saved payee${n === 1 ? "" : "s"}. Their names, wallet addresses and notes are in context/contacts.json (or call list_allowed). Draft only to a saved payee's address.`
        : "- Payees you may draft to: none yet.",
    );
  }
  if (r.abilities.pettyCash) lines.push(`- Petty cash: up to ${usd(c.topUpMaxUsd)} per request; the contract caps the week.`);
  if (c.maxPaymentsPerHour !== null) lines.push(`- At most ${c.maxPaymentsPerHour} payments per hour.`);
  if (c.expiresAt) lines.push(`- Money abilities end at ${c.expiresAt}.`);
  return lines.join("\n") + "\n";
}
