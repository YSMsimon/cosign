/**
 * One line per thing the agent did, in plain words, from the tool's name, its arguments and its result (the same
 * record the thread keeps). Used for a finished turn and, while a turn runs, for each step as it arrives.
 */
type Args = Record<string, unknown>;
type Result = Record<string, unknown> | null;

const usd = (x: unknown) => {
  const n = Number(x);
  return Number.isFinite(n) ? `$${n < 1 ? n.toFixed(2) : n % 1 ? n.toFixed(2) : n}` : "";
};
const short = (a: unknown) => {
  const s = String(a ?? "");
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
};
const host = (u: unknown) => {
  try {
    return new URL(String(u)).host;
  } catch {
    return String(u ?? "an API");
  }
};

/** What a tool call did, without its outcome. */
function doing(name: string, a: Args, r: Result): string {
  switch (name) {
    case "get_balances":
      return "Checked the balances";
    case "list_proposals":
      return "Read the treasury proposals";
    case "list_allowed":
      return "Looked up who it may pay";
    case "discover_services":
      return a.query ? `Looked for paid APIs: ${a.query}` : "Looked for paid APIs";
    case "paid_fetch": {
      const paid = r?.paid as { amountUsd?: unknown } | undefined;
      return paid ? `Paid ${usd(paid.amountUsd)} for ${host(a.url)}` : `Called ${host(a.url)}`;
    }
    case "propose_payment":
      return r?.proposalId !== undefined ? `Drafted proposal #${r.proposalId} · ${usd(a.amount_usd)} to ${short(a.to)}` : `Drafted ${usd(a.amount_usd)} to ${short(a.to)}`;
    case "request_topup":
      return `Refilled its wallet with ${usd(a.amount_usd)} from the treasury`;
    case "send_usdc":
      return `Sent ${usd(a.amount_usd)} to ${short(a.to)}`;
    case "swap":
      return `Swapped ${usd(a.amount_usd)} of USDC into ${a.token_out ?? "a token"}`;
    case "bridge":
      return `Bridged ${usd(a.amount_usd)} to ${String(a.chain ?? "another chain").replace(/_/g, " ")}`;
    case "gateway_deposit":
      return `Moved ${usd(a.amount_usd)} into its Gateway balance`;
    case "earn":
      return a.action === "deposit" ? `Put ${usd(a.amount_usd)} in the Earn vault` : a.action === "withdraw" ? "Took money out of the Earn vault" : "Checked the Earn vault";
    case "borrow":
      return "Checked the borrow rates";
    case "request_funds":
      return `Asked a person to add ${usd(a.amount_usd)} to the treasury`;
    case "list_team":
      return "Checked who's on the team";
    case "mention":
      return `Asked @${String(a.who ?? "a teammate").replace(/^@/, "")}`;
    case "memory_write":
      return "Saved a note to memory";
    case "memory_read":
      return "Read a note from memory";
    case "memory_search":
      return a.query ? `Searched its memory for “${a.query}”` : "Searched its memory";
    case "memory_archive":
      return "Archived a note";
    case "sandbox_bash":
      return "Ran a command on its computer";
    case "read_file":
    case "list_dir":
      return "Looked at its files";
    case "write_file":
    case "edit_file":
      return "Wrote a file on its computer";
    default:
      return name.replace(/_/g, " ");
  }
}

export type StepLine = { label: string; refused?: string; error?: string; pending?: string };

/** The line for one tool call, with how it ended: refused (by the rules), failed, or waiting for a person. */
export function stepLine(name: string, args: Args, result: unknown): StepLine {
  const r = result && typeof result === "object" ? (result as Result) : null;
  const label = doing(name, args ?? {}, r);
  if (r?.refused === true) return { label: `${label} · refused`, refused: String(r.reason ?? "") };
  if (r?.pending === true) return { label: `${label} · waiting for a person`, pending: String(r.reason ?? "") };
  if (typeof r?.error === "string") return { label: `${label} · failed`, error: r.error };
  return { label };
}

/** A web or X search Grok ran itself. */
export const searchLine = (tool: string, query: unknown) => `${tool.includes("x_search") ? "Searched X" : "Searched the web"}${query ? `: ${query}` : ""}`;

/** The one-line title of a turn's steps: how long it took and how many things it did. */
export function turnTitle(steps: number, ms: number | null) {
  const secs = ms !== null && ms > 0 ? Math.max(1, Math.round(ms / 1000)) : null;
  const what = `${steps} step${steps === 1 ? "" : "s"}`;
  return secs ? `Worked for ${secs} s · ${what}` : what;
}
