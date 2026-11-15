"use client";

/**
 * What else shows in a conversation besides your turns: the agent's background jobs (on its Grok Bot routine, or our
 * own loop when none is connected) and the team's @mentions to and from it. Plus the cards under a turn's tool calls
 * (approvals, payments to cosign, funding requests): `useToolCards`.
 */
import { CalendarClock } from "lucide-react";
import { Tag } from "@/components/ui/tag";
import { api, type AgentView, type Task, type TeamMessage } from "@/lib/client/api";
import { useData } from "@/lib/client/data";
import type { Agent } from "../../mockups/v2/agents";
import { Said, type Member } from "../../mockups/v2/mentions";
import { Steps } from "../../mockups/v2/parts";
import { AgentSaid, ChainEvent, GrokSaid, Words } from "../../mockups/v2/thread";
import { hueOf, useAgentsData } from "../agents-data";
import { useCosign } from "../cosign";
import { ToolCard } from "./cards";
import type { Extra, ToolCall } from "./thread-view";

const STATUS: Record<string, string> = {
  queued: "Waiting to start",
  sent: "Sent to Grok Bot",
  acked: "Grok Bot picked it up",
  working: "Working in the background",
  done: "Finished in the background",
  failed: "Couldn't finish",
};

/** One background job: what was asked, what it did (its recorded steps), and its result. */
function JobView({ task, agent }: { task: Task; agent: Agent }) {
  const running = !["done", "failed"].includes(task.status);
  const tools = task.progress.filter((p) => p.kind === "tool").map((p) => p.message);
  const notes = task.progress.filter((p) => p.kind !== "tool").map((p) => p.message);
  const body = (
    <>
      <Steps running={running} title={`${STATUS[task.status] ?? task.status} · ${task.instructions.length > 70 ? `${task.instructions.slice(0, 67)}…` : task.instructions}`} steps={[...notes, ...tools]} />
      {(task.result || task.error) && (
        <Words>
          <Said text={task.result ?? `Couldn't finish: ${task.error}`} members={[]} />
        </Words>
      )}
    </>
  );
  // a job on Grok Bot is Grok Bot's turn (its own icon, "Background"); on our own loop it is the agent's, tagged
  return task.engine === "grokbot" ? (
    <GrokSaid>{body}</GrokSaid>
  ) : (
    <AgentSaid name={agent.name} hue={agent.hue} thinking={running} tag={<Tag size="sm" variant="secondary">Background</Tag>}>
      {body}
    </AgentSaid>
  );
}

/** A team message to or from this agent: who said it, @mentions drawn as chips. */
function TeamLine({ m, members, agents }: { m: TeamMessage; members: Member[]; agents: { id: string; name: string; hue: string | null }[] }) {
  const from = m.fromKind === "agent" ? agents.find((a) => a.id === m.fromId) : undefined;
  const to = m.toKind === "agent" ? agents.find((a) => a.id === m.toId)?.name : members.find((x) => x.id === m.toId)?.name;
  const text = to && !m.text.includes(`@${to}`) ? `@${to} ${m.text}` : m.text;
  if (!from) {
    return (
      <ChainEvent icon={<CalendarClock />}>
        <Said text={text} members={members} />
      </ChainEvent>
    );
  }
  return (
    <AgentSaid name={from.name} hue={hueOf(from)}>
      <Words>
        <Said text={text} members={members} />
      </Words>
    </AgentSaid>
  );
}

export function useChatExtras(agent: Agent | undefined, view: AgentView | undefined, members: Member[]): Extra[] {
  const { wsId, ws } = useCosign();
  const { tasks, views } = useAgentsData();
  const feed = useData(`team-messages:${wsId}`, () => api.teamMessages(wsId, 200));
  if (!agent || !view) return [];
  const me = ws.me.memberId;
  const jobs = tasks.filter((t) => t.agentId === agent.id && t.kind !== "voice" && t.requestedBy === me && t.source !== "test");
  const mine = new Set(jobs.map((t) => t.id));
  const messages = (feed.data?.messages ?? []).filter(
    (m) => (m.fromKind === "agent" && m.fromId === agent.id) || (m.toKind === "agent" && m.toId === agent.id) || (m.fromTaskId && mine.has(m.fromTaskId)),
  );
  return [
    ...jobs.map((t) => ({ key: `job-${t.id}`, t: t.createdAt, node: <JobView task={t} agent={agent} /> })),
    ...messages.map((m) => ({ key: `team-${m.id}`, t: m.createdAt, node: <TeamLine m={m} members={members} agents={views} /> })),
  ];
}

/** The card for a tool call, if it needs one (an approval, a payment to cosign, a funding request). */
export function useToolCards(agent: Agent | undefined) {
  function cardFor(call: ToolCall) {
    return agent ? <ToolCard call={call} agent={agent} /> : null;
  }
  return cardFor;
}

