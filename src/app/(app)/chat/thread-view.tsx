"use client";

/**
 * Your conversation with one agent, drawn the way the design board draws it: your turns on the right, the agent's
 * turns with its orb, what it did (shadcn Trace, one line until opened), its words, and a card for anything that needs
 * you or was refused. Background jobs (Grok Bot) and team @mentions sit between the turns at the time they happened.
 */
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Tag } from "@/components/ui/tag";
import type { ThreadMessage } from "@/lib/client/api";
import type { Agent } from "../../mockups/v2/agents";
import type { Member } from "../../mockups/v2/mentions";
import { Said } from "../../mockups/v2/mentions";
import { AgentOrb, Refusal, Steps } from "../../mockups/v2/parts";
import { Words, YouSaid } from "../../mockups/v2/thread";
import { searchLine, stepLine, turnTitle, type LiveStep } from "./steps";

export type ToolCall = { name: string; args: Record<string, unknown>; result: unknown; t: string };
export type Turn =
  | { kind: "you"; key: string; text: string; via?: string; t: string }
  | { kind: "agent"; key: string; tools: ToolCall[]; searches: string[]; text: string | null; via?: string; t: string; ms: number | null };

/** The agent's turn while it is still working (from the live stream), until the saved thread has it. */
export type LiveTurn = { prompt: string; steps: LiveStep[]; text?: string; error?: string; running: boolean; startedAt: number; endedAt?: number };

/** Something else in the conversation, placed by time: a background job or a team message. */
export type Extra = { key: string; t: string; node: React.ReactNode };

/** Group the saved transcript into turns: your message, then everything the agent did and said after it. */
export function buildTurns(messages: ThreadMessage[]): Turn[] {
  const out: Turn[] = [];
  let cur: Extract<Turn, { kind: "agent" }> | null = null;
  let askedAt: number | null = null;
  messages.forEach((raw, i) => {
    const m = raw as { kind: string; text?: string; name?: string; args?: Record<string, unknown>; result?: unknown; t: string; via?: string; query?: string; tool?: string };
    if (m.kind === "user") {
      out.push({ kind: "you", key: `u${i}`, text: m.text ?? "", via: m.via, t: m.t });
      cur = null;
      askedAt = Date.parse(m.t);
      return;
    }
    if (!cur) {
      cur = { kind: "agent", key: `a${i}`, tools: [], searches: [], text: null, via: m.via, t: m.t, ms: null };
      out.push(cur);
    }
    if (m.kind === "tool") cur.tools.push({ name: m.name ?? "tool", args: m.args ?? {}, result: m.result ?? null, t: m.t });
    else if (m.kind === "search") cur.searches.push(searchLine(m.tool ?? "", m.query));
    else if (m.kind === "assistant") {
      cur.text = m.text ?? "";
      cur.via = m.via ?? cur.via;
      cur.t = m.t;
      cur.ms = askedAt !== null ? Date.parse(m.t) - askedAt : null;
      cur = null;
    }
  });
  return out;
}

/** Tools that move or ask for money: a refusal of one of these gets its own red card, not just a line. */
const MONEY = new Set(["paid_fetch", "propose_payment", "request_topup", "send_usdc", "swap", "bridge", "gateway_deposit", "earn", "borrow"]);

function AgentFace({ agent, thinking = false }: { agent: Agent; thinking?: boolean }) {
  return (
    <MessageAvatar className="self-start">
      {thinking ? <AgentOrb hue={agent.hue} state="thinking" className="size-8" /> : <AgentOrb hue={agent.hue} className="size-8" />}
    </MessageAvatar>
  );
}

/** The cards under an agent's turn: refusals here; approvals, payments and funding requests come from `cards`. */
function TurnCards({ tools, cards }: { tools: ToolCall[]; cards?: (call: ToolCall) => React.ReactNode }) {
  return (
    <>
      {tools.map((c, i) => {
        const r = c.result as { refused?: boolean; reason?: string } | null;
        if (r?.refused && MONEY.has(c.name)) {
          return (
            <Refusal key={i} title="Refused · nothing was signed">
              {r.reason}
            </Refusal>
          );
        }
        const card = cards?.(c);
        return card ? <div key={i}>{card}</div> : null;
      })}
    </>
  );
}

export function ThreadView({
  agent,
  turns,
  live,
  extras = [],
  members,
  cards,
}: {
  agent: Agent;
  turns: Turn[];
  live: LiveTurn | null;
  extras?: Extra[];
  members: Member[];
  cards?: (call: ToolCall) => React.ReactNode;
}) {
  // turns, background jobs and team messages, in the order they happened
  const items: { key: string; t: string; node: React.ReactNode; anchor: boolean }[] = [
    ...turns.map((turn) => ({ key: turn.key, t: turn.t, anchor: turn.kind === "you", node: <TurnView turn={turn} agent={agent} members={members} cards={cards} /> })),
    ...extras.map((x) => ({ key: x.key, t: x.t, anchor: false, node: x.node })),
  ].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  // only your latest message is a scroll anchor: the scroller jumps to the first anchor it hasn't handled when the list
  // changes without growing (the live turn swapped for the saved one), and with every message an anchor that was your
  // oldest one, far up the conversation
  const lastYou = live ? -1 : items.findLastIndex((it) => it.anchor);
  items.forEach((it, i) => (it.anchor = i === lastYou));

  return (
    <div className="min-h-0 flex-1">
      <MessageScrollerProvider autoScroll>
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto max-w-2xl gap-6 px-8 py-4">
              {items.map((it) => (
                <MessageScrollerItem key={it.key} messageId={it.key} scrollAnchor={it.anchor}>
                  {it.node}
                </MessageScrollerItem>
              ))}
              {live && (
                <>
                  <MessageScrollerItem messageId="live-you" scrollAnchor>
                    <YouSaid line={{ who: "you", text: live.prompt }} />
                  </MessageScrollerItem>
                  <MessageScrollerItem messageId="live-agent">
                    <Message className="gap-3">
                      <AgentFace agent={agent} thinking={live.running} />
                      <MessageContent className="gap-3">
                        <Steps
                          key={live.running ? "running" : "done"}
                          running={live.running}
                          open={live.running}
                          title={live.running ? (live.steps.at(-1)?.label ?? "Thinking") : turnTitle(live.steps.length, (live.endedAt ?? live.startedAt) - live.startedAt)}
                          steps={live.steps.map((s) => s.label)}
                        />
                        {live.text && (
                          <Words>
                            <Said text={live.text} members={members} />
                          </Words>
                        )}
                        {live.error && (
                          <Refusal title="The agent stopped">{live.error}</Refusal>
                        )}
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                </>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  );
}

function TurnView({ turn, agent, members, cards }: { turn: Turn; agent: Agent; members: Member[]; cards?: (call: ToolCall) => React.ReactNode }) {
  if (turn.kind === "you") return <YouSaid line={{ who: "you", text: turn.text, via: turn.via === "voice" ? "voice" : undefined }} />;
  const lines = [...turn.searches, ...turn.tools.map((c) => stepLine(c.name, c.args, c.result).label)];
  return (
    <Message className="gap-3">
      <AgentFace agent={agent} />
      <MessageContent className="gap-3">
        {turn.via === "voice" && (
          <MessageHeader>
            <Tag variant="info">Voice</Tag>
          </MessageHeader>
        )}
        {lines.length > 0 && <Steps title={turnTitle(lines.length, turn.ms)} steps={lines} />}
        {turn.text !== null && turn.text !== "" && (
          <Words>
            <Said text={turn.text} members={members} />
          </Words>
        )}
        <TurnCards tools={turn.tools} cards={cards} />
      </MessageContent>
    </Message>
  );
}
