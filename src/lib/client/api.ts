/**
 * The browser's client for Cosign's API (`/api/v1`, same origin, the httpOnly session cookie goes along).
 * Response types come straight from the server functions (type-only imports, erased at build), so the two can't drift.
 */
import type { ActivityRow, ContactRow, FundingRequestRow, TeamMessageRow } from "@/lib/db/schema";
import type { agentDetail, agentView, listAgents } from "@/lib/server/agents";
import type { readThread } from "@/lib/server/chat";
import type { taskView } from "@/lib/server/grokbot";
import type { PreparedTx } from "@/lib/server/http";
import type { listApprovals, listProposals } from "@/lib/server/money";
import type { listTeam } from "@/lib/server/team";
import type { startVoice } from "@/lib/server/voice";
import type { listMembers, listRoles, myWorkspaces, workspaceDetail } from "@/lib/server/workspaces";
import type { agentSpend, workspaceSpend } from "@/lib/server/spend";

export type Me = { address: string; workspaces: ReturnType<typeof myWorkspaces> };
export type WorkspaceDetail = Awaited<ReturnType<typeof workspaceDetail>>;
export type AgentView = ReturnType<typeof agentView>;
export type AgentList = ReturnType<typeof listAgents>;
export type AgentDetail = Awaited<ReturnType<typeof agentDetail>>;
export type Members = Awaited<ReturnType<typeof listMembers>>;
export type Member = Members[number];
export type Role = ReturnType<typeof listRoles>[number];
export type Proposals = Awaited<ReturnType<typeof listProposals>>;
export type Proposal = Proposals["proposals"][number];
export type Approval = ReturnType<typeof listApprovals>[number];
export type Team = ReturnType<typeof listTeam>;
export type TeamMessage = TeamMessageRow;
export type Thread = ReturnType<typeof readThread>;
export type ThreadMessage = Thread["messages"][number];
export type Task = ReturnType<typeof taskView>;
export type FundingRequest = FundingRequestRow;
export type Contact = ContactRow;
export type Activity = Omit<ActivityRow, "raw"> & { explorer?: string };
export type VoiceSession = Awaited<ReturnType<typeof startVoice>>;
export type AgentSpend = ReturnType<typeof agentSpend>;
export type WorkspaceSpend = ReturnType<typeof workspaceSpend>;
export type { PreparedTx };

/** What the server said when it said no: its own words, and the HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/v1${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
    cache: "no-store",
  });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!r.ok) {
    const j = json as { error?: string; detail?: unknown } | null;
    const detail = Array.isArray(j?.detail) ? `: ${(j.detail as string[]).join("; ")}` : "";
    throw new ApiError(r.status, `${j?.error ?? `The server answered ${r.status}`}${detail}`, j?.detail);
  }
  return json as T;
}

const get = <T>(path: string) => call<T>("GET", path);
const post = <T>(path: string, body: unknown = {}) => call<T>("POST", path, body);
const patch = <T>(path: string, body: unknown) => call<T>("PATCH", path, body);
const del = <T>(path: string) => call<T>("DELETE", path);

export const api = {
  // sign-in
  nonce: () => get<{ nonce: string }>("/auth/nonce"),
  verify: (message: string, signature: string) => post<Me>("/auth/verify", { message, signature }),
  logout: () => post<{ ok: true }>("/auth/logout"),
  me: () => get<Me>("/me"),

  // workspace
  workspace: (ws: string) => get<WorkspaceDetail>(`/workspaces/${ws}`),
  members: (ws: string) => get<Members>(`/workspaces/${ws}/members`),
  invite: (ws: string, b: { address: string; roleId: string; title?: string }) => post<{ member: unknown }>(`/workspaces/${ws}/members`, b),
  updateMember: (ws: string, mid: string, b: { roleId?: string; title?: string | null }) => patch<unknown>(`/workspaces/${ws}/members/${mid}`, b),
  roles: (ws: string) => get<{ roles: Role[] }>(`/workspaces/${ws}/roles`),
  contacts: (ws: string) => get<{ contacts: Contact[] }>(`/workspaces/${ws}/contacts`),
  addContact: (ws: string, b: { name: string; address: string; notes?: string }) => post<{ contact: Contact }>(`/workspaces/${ws}/contacts`, b),
  approverChangeTx: (ws: string, b: { kind: "add" | "remove" | "threshold"; address?: string; newThreshold?: number }) => post<{ tx: PreparedTx }>(`/workspaces/${ws}/approver-changes`, b),
  agentOnchain: (ag: string) => get<AgentDetail["onchain"]>(`/agents/${ag}/onchain`),
  team: (ws: string) => get<Team>(`/workspaces/${ws}/team`),
  teamMessages: (ws: string, limit = 100) => get<{ messages: TeamMessage[] }>(`/workspaces/${ws}/team/messages?limit=${limit}`),
  tasks: (ws: string) => get<{ tasks: Task[] }>(`/workspaces/${ws}/tasks`),
  activity: (ws: string, limit = 50) => get<{ activity: Activity[] }>(`/workspaces/${ws}/activity?limit=${limit}`),
  spend: (ws: string, days = 30) => get<WorkspaceSpend>(`/workspaces/${ws}/spend?days=${days}`),

  // money
  proposals: (ws: string, open = false) => get<Proposals>(`/workspaces/${ws}/proposals${open ? "?status=open" : ""}`),
  cosignTx: (ws: string, pid: number) => get<{ tx: PreparedTx }>(`/workspaces/${ws}/proposals/${pid}/cosign`),
  cancelTx: (ws: string, pid: number) => get<{ tx: PreparedTx }>(`/workspaces/${ws}/proposals/${pid}/cancel`),
  approvals: (ws: string, status: "pending" | "all" = "pending") => get<{ approvals: Approval[] }>(`/workspaces/${ws}/approvals?status=${status}`),
  decide: (ws: string, rid: string, decision: "approve" | "deny") => post<{ approval: unknown }>(`/workspaces/${ws}/approvals/${rid}`, { decision }),
  fundingRequests: (ws: string) => get<{ requests: FundingRequest[] }>(`/workspaces/${ws}/funding-requests`),
  declineFunding: (ws: string, rid: string) => post<{ request: FundingRequest }>(`/workspaces/${ws}/funding-requests/${rid}/decline`),
  onramp: (ws: string, b: { requestId?: string; amountUsd?: number }) =>
    post<{ widgetUrl: string; expiresAt: string; sandbox: boolean; destination: string; requestId: string | null }>(`/workspaces/${ws}/onramp`, b),

  // agents
  agents: (ws: string) => get<{ agents: AgentList }>(`/workspaces/${ws}/agents`),
  createAgent: (ws: string, b: { name: string; prompt: string; visibility: "private" | "team"; hue?: string; preset?: "readonly" | "buyer" | "clerk" }) =>
    post<{ agent: AgentView }>(`/workspaces/${ws}/agents`, b),
  agent: (ag: string) => get<{ agent: AgentDetail }>(`/agents/${ag}`),
  updateAgent: (ag: string, b: { name?: string; prompt?: string; abilities?: Record<string, unknown>; controls?: Record<string, unknown> }) =>
    patch<{ agent: AgentView }>(`/agents/${ag}`, b),
  retire: (ag: string) => post<unknown>(`/agents/${ag}/retire`),
  agentSpend: (ag: string, days = 30) => get<AgentSpend>(`/agents/${ag}/spend?days=${days}`),
  thread: (ag: string) => get<Thread>(`/agents/${ag}/thread`),
  startTask: (ag: string, instructions: string) => post<{ task: Task }>(`/agents/${ag}/tasks`, { instructions }),
  grokbot: (ag: string) => get<{ connection: { status: string; connectedAt?: string | null; lastError?: string | null }; setupMessage: string }>(`/agents/${ag}/grokbot`),
  voiceStatus: (ag: string) => get<{ configured: boolean; elevenAgentId: string | null }>(`/agents/${ag}/voice`),
  startVoice: (ag: string) => post<VoiceSession>(`/agents/${ag}/voice`),
};

export { del as _del };

/**
 * One chat turn over Server-Sent Events: `step` for every loop event while the agent works, then `done` (or `error`).
 * Calls `onStep` as each event arrives and resolves with the final answer.
 */
export async function chatTurn(
  ag: string,
  message: string,
  onStep: (s: { type: string; ms: number; data: Record<string, unknown> }) => void,
  signal?: AbortSignal,
): Promise<{ finalText: string }> {
  const r = await fetch(`/api/v1/agents/${ag}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
    credentials: "same-origin",
    signal,
  });
  if (!(r.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const j = (await r.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(r.status, j?.error ?? `The server answered ${r.status}`);
  }
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const ev = /^event: (.+)$/m.exec(chunk)?.[1];
      const data = /^data: (.+)$/m.exec(chunk)?.[1];
      if (!ev || !data) continue;
      const parsed = JSON.parse(data);
      if (ev === "step") onStep(parsed);
      else if (ev === "done") return parsed as { finalText: string };
      else if (ev === "error") throw new ApiError(parsed.status ?? 500, parsed.error ?? "the turn failed");
    }
  }
  throw new ApiError(500, "the answer stopped before it finished");
}
