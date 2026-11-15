"use client";

import { useState } from "react";
import { CalendarClock, Landmark, Lock, Radio, UserPlus } from "lucide-react";
import { DescriptionList } from "@/components/description-list";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Composer, type Picked } from "./composer";
import { GROK_BOT, mentionedIn, personMember, roomMembers, Said } from "./mentions";
import { AddressLine, EXPLORER, LENA, TREASURY } from "./money";
import { ApprovalRow, Refusal, Steps } from "./parts";
import { InviteToRoomDialog, JoinRoomEmpty, ME, RoomIcon, RoomMembers } from "./rooms";
import type { Agent } from "./agents";
import { roomKey, useAgents, useLines, useRooms, useTeam, type Room, type Teammate } from "./store";
import { Tag } from "@/components/ui/tag";
import { AgentSaid, ChainEvent, GrokSaid, PersonSaid, Words, YouSaid } from "./thread";

/* sample transactions for the contractor run (mock) */
const TX = {
  lena: "0x9f1c4b7e2a6d8c0f3e5b1a9d7c2e4f6a8b0c1d3e5f7a9b2c4d6e8f0a1b3c5d7e",
  noor: "0x3a7e9c1b5d2f8e4a6c0b9d1f3e5a7c9b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a2c",
  kai: "0x7d2b6f0a4c8e1d5b9f3a7c2e6b0d4f8a1c5e9b3d7f0a2c6e8b4d1f5a9c3e7b0d",
};
const STRANGER = "0x5e3f9a1c7b2d4e6f8a0b1c3d5e7f9a2b4c6d8e0f";

/** What an agent (or Grok Bot) asked in a room is doing right now, as the real app reports it. */
export type RoomReply = {
  title: string;
  steps: string[];
  text?: string;
  error?: string;
  running: boolean;
  /** a Grok Bot job that runs on this agent's own loop (no routine connected): the agent's turn, tagged Background */
  by?: string;
};

/**
 * The real app's answer to a message in a room: run the agent it names, or start a Grok Bot job when it names Grok Bot
 * (for the agents it names, then the room's), calling `update` as the work goes. Without it the room is the prototype
 * and answers with sample text.
 */
export type RoomAsk = (
  to: { kind: "agent"; name: string } | { kind: "grokbot"; agents: string[] },
  text: string,
  room: Room,
  update: (r: RoomReply) => void,
) => Promise<RoomReply>;

/**
 * A room: a shared conversation for teammates and agents. Everyone in it sees every message; an agent answers when
 * someone names it with @, following the room's guidelines. Payments an agent drafts here are approved here too.
 * Prototype: rooms and messages live in the browser (./store).
 */
export function RoomView({
  room,
  files,
  setFiles,
  ask,
  people,
  scope,
}: {
  room: Room;
  files: Picked[];
  setFiles: (update: (cur: Picked[]) => Picked[]) => void;
  ask?: RoomAsk;
  /** the real app's agents and people (else the board's sample ones) */
  people?: { agents: Agent[]; team: Teammate[] };
  /** keeps this room's messages apart per workspace (the real app passes the workspace id) */
  scope?: string;
}) {
  const sample = { agents: useAgents().agents, team: useTeam().team };
  const { agents, team } = people ?? sample;
  const key = scope ? `${scope}:${roomKey(room.id)}` : roomKey(room.id);
  const { addMembers } = useRooms();
  const { lines, say } = useLines();
  const [inviting, setInviting] = useState(false);
  const [replying, setReplying] = useState<string | null>(null);
  const [paid, setPaid] = useState(false); // prototype: approving the contractor run shows Grok Bot's onchain check
  const [replies, setReplies] = useState<{ rid: string; author: string; reply: RoomReply }[]>([]); // real answers still coming

  const extra = lines[key] ?? [];
  // only your latest message anchors the scroll (see the chat's thread view: the scroller jumps to the first anchor it
  // hasn't handled when an answer replaces its live copy)
  const lastYou = extra.findLastIndex((l) => l.who === "you");
  const roomAgents = agents.filter((a) => room.members.includes(a.id));
  const members = roomMembers(room, team, agents);
  /* who a message can name, you included (Grok Bot may @ you) */
  const named = [...members, ...team.filter((t) => t.you).map(personMember)];
  const replier = agents.find((a) => a.id === replying);
  const seeded = room.id === "finance";

  if (!room.members.includes(ME)) {
    return <JoinRoomEmpty room={room} onJoin={() => addMembers(room.id, [ME])} />;
  }

  /* the real app: the named agent answers for real (steps and words as it works), or Grok Bot takes the job */
  const askReal = (text: string, run: RoomAsk) => {
    const asked = mentionedIn(text, members).filter((m) => m.kind === "agent" && m.id !== GROK_BOT.id);
    const grok = mentionedIn(text, [GROK_BOT]).length > 0;
    if (!grok && !asked.length) return;
    const author = grok ? GROK_BOT.id : asked[0].id;
    const to = grok
      ? { kind: "grokbot" as const, agents: [...new Set([...asked.map((m) => m.name), ...roomAgents.map((a) => a.name)])] }
      : { kind: "agent" as const, name: asked[0].name };
    const rid = `${Date.now()}-${author}`; // this reply, while it runs
    const start: RoomReply = { title: grok ? "Handing it to Grok Bot" : "Thinking", steps: [], running: true };
    setReplies((cur) => [...cur, { rid, author, reply: start }]);
    const update = (reply: RoomReply) => setReplies((cur) => cur.map((x) => (x.rid === rid ? { ...x, reply } : x)));
    void run(to, text, room, update)
      .catch((e: Error): RoomReply => ({ ...start, running: false, error: e.message }))
      .then((r) => {
        say(key, { who: "agent", author, text: r.text ?? "", steps: r.steps.length ? { title: r.title, lines: r.steps } : undefined, error: r.error, by: r.by });
        setReplies((cur) => cur.filter((x) => x.rid !== rid));
      });
  };

  const send = (text: string, picked: Picked[]) => {
    say(key, { who: "you", text, files: picked.length ? picked.map((f) => f.name) : undefined });
    if (ask) return askReal(text, ask);
    const [first] = mentionedIn(text, members).filter((m) => m.kind === "agent"); // room agents and Grok Bot
    if (!first) return;
    if (first.id === GROK_BOT.id) {
      /* Grok Bot works in the background: no typing dots, it reports when done */
      setTimeout(() => say(key, { who: "agent", author: GROK_BOT.id, text: "(Prototype) On it in the background. I'll post here when it's done, and @ whoever needs to act." }), 1200);
      return;
    }
    const agent = roomAgents.find((a) => a.id === first.id)!;
    setReplying(agent.id);
    setTimeout(() => {
      say(key, { who: "agent", author: agent.id, text: `(Prototype) ${agent.name} would answer here for #${room.name}, following its guidelines.` });
      setReplying(null);
    }, 1500);
  };

  return (
    <>
      <header className="flex items-center gap-3 px-8 py-4">
        <RoomIcon room={room} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-medium">
            {room.name}
            {room.visibility === "private" && <Lock className="size-3.5 text-muted-foreground" aria-label="Private room" />}
          </div>
          {room.guidelines && <p className="truncate text-sm text-muted-foreground">{room.guidelines}</p>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <RoomMembers room={room} team={team} agents={agents} />
          <Button variant="outline" size="sm" onClick={() => setInviting(true)}>
            <UserPlus /> Invite
          </Button>
        </div>
      </header>

      {seeded || extra.length || replying || replies.length ? (
        <div className="min-h-0 flex-1">
          <MessageScrollerProvider autoScroll>
            <MessageScroller>
              <MessageScrollerViewport>
                <MessageScrollerContent className="mx-auto max-w-2xl gap-6 px-8 py-4">
                  {/* sample: an agent asks another agent, which hands the approval to a teammate; sources are cited inline */}
                  {seeded && (
                    <>
                      <MessageScrollerItem messageId="r1">
                        <PersonSaid name="Priya" initials="PR" line={{ who: "person", text: "" }}>
                          <Said text="Lena sent invoice 120 for the frontend work. @Clerk can you handle it?" members={members} />
                        </PersonSaid>
                      </MessageScrollerItem>
                      <MessageScrollerItem messageId="r2">
                        <AgentSaid name="Clerk" hue="blue">
                          <Steps
                            title="Handled invoice 120 in 14 s"
                            steps={["Read invoice 120 · paid $0.01", "Vendor check on Lena · paid $0.02 · risk low", "Name and address match the saved payee", "Drafted proposal #5"]}
                          />
                          <Words>
                            <Said
                              text="Drafted $2.40 to Lena for invoice 120 [[invoice]]. Her address matches the saved payee [[payee]]. @Auditor can you review it before Priya approves?"
                              members={members}
                            />
                          </Words>
                        </AgentSaid>
                      </MessageScrollerItem>
                      <MessageScrollerItem messageId="r3">
                        <AgentSaid name="Auditor" hue="violet">
                          <Steps
                            title="Reviewed proposal #5 in 6 s"
                            steps={["Read proposal #5 onchain", "Compared it with invoice 120", "Lena's history · 3 paid, none disputed"]}
                          />
                          <Words>
                            <Said
                              text="The amount and payee match the invoice [[invoice]] and the proposal onchain [[proposal]]. @Priya it's ready for you."
                              members={members}
                            />
                          </Words>
                          <ApprovalRow
                            title="Approve $2.40 to Lena?"
                            description="Proposal #5 · you sign in your own wallet"
                            address={{ value: LENA.address, label: "Lena's wallet address" }}
                            approved={{ title: "Paid $2.40 to Lena", note: "Proposal #5 · approved by you", href: `${EXPLORER}${TREASURY.address}` }}
                            denied={{ title: "Denied", note: "Proposal #5 cancelled · nothing was paid" }}
                            pending={["Connecting to your wallet…", "Waiting for your signature…", "Sending your approval to the treasury on Arc…"]}
                          />
                        </AgentSaid>
                      </MessageScrollerItem>

                      {/* the team at work: you hand a routine to Clerk, Clerk hands it to Grok Bot, and on Friday Grok Bot runs it,
                          checks Clerk's drafts against the invoices, hands a mistake back, and confirms the payments onchain */}
                      <MessageScrollerItem messageId="r4" scrollAnchor={extra.length === 0 && replies.length === 0}>
                        <YouSaid line={{ who: "you", text: "x" }}>
                          <Said text="@Clerk set up a schedule: pay the contractors every Friday at 9." members={named} />
                        </YouSaid>
                      </MessageScrollerItem>
                      <MessageScrollerItem messageId="r5">
                        <AgentSaid name="Clerk" hue="blue">
                          <Steps title="Set up the Friday run in 3 s" steps={["Looked up the team · Clerk, Auditor, Scribe, Grok Bot", "Created a schedule · Fridays 9:00 · run by Grok Bot", "Mentioned Grok Bot"]} />
                          <Words>
                            <Said text="Done. @Grok Bot will run it every Friday at 9:00 and tell me if anything is off." members={named} />
                          </Words>
                        </AgentSaid>
                      </MessageScrollerItem>
                      <MessageScrollerItem messageId="r6">
                        <GrokSaid>
                          <Alert icon={<CalendarClock />}>
                            <AlertTitle>Scheduled · every Friday at 9:00</AlertTitle>
                            <AlertDescription>Pay the contractors, for Clerk · next run Fri, Nov 20</AlertDescription>
                          </Alert>
                        </GrokSaid>
                      </MessageScrollerItem>
                      <MessageScrollerItem messageId="r7">
                        <ChainEvent icon={<CalendarClock />}>Friday 9:00 · Grok Bot started the contractor run</ChainEvent>
                      </MessageScrollerItem>
                      <MessageScrollerItem messageId="r8">
                        <GrokSaid>
                          <Steps title="Checked what's due in 40 s" steps={["Read 3 contractor invoices", "Checked the treasury on Arc · $48.60 USDC"]} />
                          <Words>
                            <Said text="@Clerk 3 contractor invoices are due today: Lena $2.40, Noor $3.00, Kai $1.50. Please draft them." members={named} />
                          </Words>
                        </GrokSaid>
                      </MessageScrollerItem>
                      <MessageScrollerItem messageId="r9">
                        <AgentSaid name="Clerk" hue="blue">
                          <Steps title="Drafted 3 payments in 9 s" steps={["Matched Lena, Noor and Kai to saved payees", "Drafted #6 · Lena $2.40", "Drafted #7 · Noor $3.00", "Drafted #8 · Kai $1.80"]} />
                          <Words>
                            <Said text="Drafted #6, #7 and #8. @Grok Bot over to you for the check." members={named} />
                          </Words>
                        </AgentSaid>
                      </MessageScrollerItem>
                      <MessageScrollerItem messageId="r10">
                        <ChainEvent icon={<Radio />}>Onchain · 3 new proposals, seen by QuickNode</ChainEvent>
                      </MessageScrollerItem>
                      <MessageScrollerItem messageId="r11">
                        <GrokSaid>
                          <Steps title="Checked 3 drafts against their invoices" steps={["#6 matches invoice 122", "#7 matches invoice 123", "#8 is $1.80, invoice 124 says $1.50"]} />
                          <Alert variant="warning" severityLabel="Warning">
                            <AlertTitle>#8 doesn&apos;t match its invoice</AlertTitle>
                            <AlertDescription>$1.80 drafted · invoice 124 says $1.50</AlertDescription>
                          </Alert>
                          <Words>
                            <Said text="@Clerk please fix #8 before anyone approves." members={named} />
                          </Words>
                        </GrokSaid>
                      </MessageScrollerItem>
                      <MessageScrollerItem messageId="r12">
                        <AgentSaid name="Clerk" hue="blue">
                          <Steps title="Fixed #8 in 6 s" steps={["Read invoice 124 again · $1.50", "Cancelled #8", "Drafted #9 · Kai $1.50"]} />
                          <Words>
                            <Said text="I read last month's total. Cancelled #8 and drafted #9 for $1.50. @Grok Bot can you check it?" members={named} />
                          </Words>
                        </AgentSaid>
                      </MessageScrollerItem>
                      <MessageScrollerItem messageId="r13">
                        <GrokSaid>
                          <Alert variant="success">
                            <AlertTitle>#9 checked · matches invoice 124</AlertTitle>
                          </Alert>
                          <Words>
                            <Said text="@Priya #6, #7 and #9 are ready for your approval." members={named} />
                          </Words>
                          <ApprovalRow
                            title="Approve 3 contractor payments, $6.90?"
                            description="Proposals #6, #7 and #9 · you sign each one in your wallet"
                            approved={{ title: "Approved 3 payments, $6.90", note: "The treasury pays them now" }}
                            denied={{ title: "Denied", note: "Nothing was paid" }}
                            pending={["Signing #6…", "Signing #7…", "Signing #9…"]}
                            onDecide={(yes) => yes && setTimeout(() => setPaid(true), 900)}
                          />
                        </GrokSaid>
                      </MessageScrollerItem>
                      {paid && (
                        <>
                          <MessageScrollerItem messageId="r14">
                            <ChainEvent icon={<Radio />}>Onchain · 3 payments, seen by QuickNode</ChainEvent>
                          </MessageScrollerItem>
                          <MessageScrollerItem messageId="r15">
                            {/* success: Grok Bot checks each payment on Arc itself, reports with links, and @mentions no one */}
                            <GrokSaid>
                              <Alert variant="success">
                                <AlertTitle>All 3 contractors paid</AlertTitle>
                                <AlertDescription className="mt-2">
                                  <DescriptionList
                                    layout="divided"
                                    items={[
                                      { id: "lena", term: "Lena · $2.40", details: <AddressLine kind="tx" address={TX.lena} label="Lena's payment" /> },
                                      { id: "noor", term: "Noor · $3.00", details: <AddressLine kind="tx" address={TX.noor} label="Noor's payment" /> },
                                      { id: "kai", term: "Kai · $1.50", details: <AddressLine kind="tx" address={TX.kai} label="Kai's payment" /> },
                                    ]}
                                  />
                                </AlertDescription>
                              </Alert>
                              <Words>Recorded against invoices 122, 123 and 124.</Words>
                            </GrokSaid>
                          </MessageScrollerItem>
                          <MessageScrollerItem messageId="r16">
                            <ChainEvent icon={<Landmark />}>Onchain · money in, seen by QuickNode</ChainEvent>
                          </MessageScrollerItem>
                          <MessageScrollerItem messageId="r17">
                            {/* no agent can fix this one: Grok Bot asks a person */}
                            <GrokSaid>
                              <Alert variant="warning" severityLabel="Warning">
                                <AlertTitle>$5.00 came in from an unknown sender</AlertTitle>
                                <AlertDescription>
                                  <AddressLine address={STRANGER} label="The sender's address" />
                                </AlertDescription>
                              </Alert>
                              <Words>
                                <Said text="@Simon do you know who sent this? I haven't recorded it." members={named} />
                              </Words>
                            </GrokSaid>
                          </MessageScrollerItem>
                        </>
                      )}
                    </>
                  )}
                  {extra.map((l, i) => {
                    const agent = agents.find((a) => a.id === l.author);
                    const mate = team.find((t) => t.id === l.author);
                    const by = l.by ? agents.find((a) => a.name.toLowerCase() === l.by!.toLowerCase()) : undefined;
                    /* an answer: its steps (when it had any), its words, or why it stopped */
                    const answer = (
                      <>
                        {l.steps && <Steps title={l.steps.title} steps={l.steps.lines} />}
                        {l.text && (
                          <Words>
                            <Said text={l.text} members={named} />
                          </Words>
                        )}
                        {l.error && <Refusal title="It stopped">{l.error}</Refusal>}
                      </>
                    );
                    return (
                      <MessageScrollerItem key={i} messageId={`x${i}`} scrollAnchor={l.who === "you" && i === lastYou}>
                        {l.who === "you" ? (
                          <YouSaid line={l}>
                            <Said text={l.text} members={members} />
                          </YouSaid>
                        ) : l.author === GROK_BOT.id && by ? (
                          <AgentSaid name={by.name} hue={by.hue} tag={<Tag size="sm" variant="secondary">Background</Tag>}>
                            {answer}
                          </AgentSaid>
                        ) : l.author === GROK_BOT.id ? (
                          <GrokSaid>{answer}</GrokSaid>
                        ) : agent ? (
                          <AgentSaid name={agent.name} hue={agent.hue}>
                            {answer}
                          </AgentSaid>
                        ) : (
                          <PersonSaid name={mate?.name ?? "Someone"} initials={mate?.initials ?? "?"} line={l}>
                            <Said text={l.text} members={members} />
                          </PersonSaid>
                        )}
                      </MessageScrollerItem>
                    );
                  })}
                  {replies.map(({ rid, author, reply: r }) => {
                    const agent = agents.find((a) => a.id === author);
                    const by = r.by ? agents.find((a) => a.name.toLowerCase() === r.by!.toLowerCase()) : undefined;
                    /* the same as an agent's turn in its own chat: the step it is on, then its words as they stream in */
                    const body = (
                      <>
                        <Steps key={r.running ? "running" : "done"} running={r.running} open={r.running && r.steps.length > 0} title={r.title} steps={r.steps} />
                        {r.text && (
                          <Words>
                            <Said text={r.text} members={named} />
                          </Words>
                        )}
                      </>
                    );
                    return (
                      <MessageScrollerItem key={rid} messageId={`reply-${rid}`}>
                        {author === GROK_BOT.id && by ? (
                          <AgentSaid name={by.name} hue={by.hue} thinking={r.running} tag={<Tag size="sm" variant="secondary">Background</Tag>}>
                            {body}
                          </AgentSaid>
                        ) : author === GROK_BOT.id || !agent ? (
                          <GrokSaid>{body}</GrokSaid>
                        ) : (
                          <AgentSaid name={agent.name} hue={agent.hue} thinking={r.running}>
                            {body}
                          </AgentSaid>
                        )}
                      </MessageScrollerItem>
                    );
                  })}
                  {replier && (
                    <MessageScrollerItem messageId="replying">
                      <AgentSaid name={replier.name} hue={replier.hue} thinking>
                        <Steps running title="Thinking" steps={[]} />
                      </AgentSaid>
                    </MessageScrollerItem>
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          </MessageScrollerProvider>
        </div>
      ) : (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia>
              <RoomIcon room={room} size="md" />
            </EmptyMedia>
            <EmptyTitle>Say hello in {room.name}</EmptyTitle>
            <EmptyDescription>
              {room.members.length} {room.members.length === 1 ? "member" : "members"}. Type @ and an agent&apos;s name to ask it.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => setInviting(true)}>
              <UserPlus /> Invite people or agents
            </Button>
          </EmptyContent>
        </Empty>
      )}

      <div className="px-8 pb-6">
        <Composer
          placeholder={roomAgents.length ? `Message ${room.name} · type @ to ask an agent or a teammate` : `Message ${room.name}`}
          files={files}
          setFiles={setFiles}
          onSend={send}
          busy={replying !== null || replies.some((x) => x.author !== GROK_BOT.id)}
          mentions={members}
        />
      </div>

      <InviteToRoomDialog open={inviting} onOpenChange={setInviting} room={room} team={team} agents={agents} onInvite={(ids) => addMembers(room.id, ids)} />
    </>
  );
}
