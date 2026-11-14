"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Bot, Coins, Hash, Wallet, Mic, MicOff, PaperclipIcon, PhoneOff, Plus, Search, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { EmptyState, EmptyStateDescription, EmptyStateTitle } from "@/components/ui/empty-state";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { loader, Matrix } from "@/components/ui/matrix";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import type { AgentState } from "@/components/ui/orb";
import { ShimmeringText } from "@/components/ui/shimmering-text";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tag } from "@/components/ui/tag";
import { AgentList, NewAgentDialog } from "../agents";
import { Composer, toPicked, type Picked } from "../composer";
import { Said } from "../mentions";
import { AgentOrb, ApprovalRow, HUE_COLORS, Shell, Steps } from "../parts";
import { RoomView } from "../room-view";
import { InviteTeammateDialog, JoinRoomDialog, ME, NewRoomDialog, RoomList } from "../rooms";
import { useAgents, useLines, useRooms, useTeam, type Line } from "../store";
import { Words, YouSaid } from "../thread";

type Phase = "connecting" | "listening" | "thinking" | "talking";

/**
 * Prototype of one voice call: the call carries on the agent's conversation (the agent already has the history),
 * and what is said goes back into it. The real call runs through ElevenLabs; here the steps are timed.
 */
const callScript = (name: string): { phase: Phase; ms: number; say?: Line; status?: string }[] => [
  { phase: "connecting", ms: 1400 },
  { phase: "talking", ms: 2600, say: { who: "agent", text: `Hi, it's ${name}. What do you need?`, via: "voice" } },
  { phase: "listening", ms: 3000, say: { who: "you", text: "What's waiting for a cosign?", via: "voice" } },
  { phase: "thinking", ms: 1800, status: "Looking at what's waiting for a cosign..." },
  { phase: "talking", ms: 3400, say: { who: "agent", text: "Proposals five and nine to Lena are waiting for your cosign.", via: "voice" } },
  { phase: "listening", ms: 0 },
];

const orbState: Record<Phase, AgentState> = { connecting: "thinking", listening: "listening", thinking: "thinking", talking: "talking" };
const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

/**
 * Subpage: rooms and agents. The left side lists the rooms you are in (shared with teammates and agents, public
 * or private) and your agents (each one conversation that keeps going); + creates or joins a room, makes an agent,
 * or invites a teammate. The thread and the message box are shadcn AI Elements; files can be dropped anywhere on the
 * page. Talk starts a voice call with an agent in ElevenLabs' design. Prototype: everything lives in the browser.
 */
export function SessionView() {
  const router = useRouter();
  const pathname = usePathname();
  const { agents, add, remove } = useAgents();
  const { lines, say } = useLines();
  const { rooms, add: addRoom, addMembers } = useRooms();
  const { team, invite } = useTeam();
  const params = useSearchParams();
  const wanted = params.get("agent");
  const room = rooms.find((r) => r.id === params.get("room"));
  const agent = agents.find((a) => a.id === wanted) ?? agents[0];
  const select = (id: string) => router.replace(`${pathname}?agent=${id}`);
  const selectRoom = (id: string) => router.replace(`${pathname}?room=${id}`);
  const [dialog, setDialog] = useState<null | "room" | "join" | "agent" | "mate">(null);

  const [inCall, setInCall] = useState(false);
  const [callFrom, setCallFrom] = useState(0); // voice lines before this call (captions show only this call's)
  const [step, setStep] = useState(0);
  const [muted, setMuted] = useState(false);
  const [files, setFiles] = useState<Picked[]>([]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [replying, setReplying] = useState(false);
  const [levels, setLevels] = useState<number[]>(Array(20).fill(0));
  const script = callScript(agent?.name ?? "");
  const current = script[Math.min(step, script.length - 1)];
  const lastSaid = useRef<number>(-1);

  // walk the call script while the call is on
  useEffect(() => {
    if (!inCall || !current.ms) return;
    const t = setTimeout(() => setStep((s) => s + 1), current.ms);
    return () => clearTimeout(t);
  }, [inCall, step, current.ms]);

  // what is said in the call goes into the agent's conversation (once per step)
  useEffect(() => {
    if (!inCall || !agent || !current.say || lastSaid.current === step) return;
    lastSaid.current = step;
    say(agent.id, current.say);
  }, [inCall, step, current.say, agent, say]);

  // the Matrix voice level: louder while the agent talks, softer while it listens
  useEffect(() => {
    if (!inCall || (current.phase !== "talking" && current.phase !== "listening")) return;
    const amp = current.phase === "talking" ? 0.9 : muted ? 0.05 : 0.4;
    const id = setInterval(() => {
      const t = performance.now();
      setLevels(Array.from({ length: 20 }, (_, i) => amp * (0.3 + 0.7 * Math.abs(Math.sin(t / 170 + i * 0.55))) * (0.65 + 0.35 * Math.random())));
    }, 90);
    return () => clearInterval(id);
  }, [inCall, current.phase, muted]);

  const startCall = () => {
    setCallFrom(agent ? (lines[agent.id] ?? []).filter((l) => l.via === "voice").length : 0);
    setStep(0);
    lastSaid.current = -1;
    setMuted(false);
    setInCall(true);
  };

  const addFiles = (list: FileList | null) => {
    if (list?.length) setFiles((cur) => [...cur, ...toPicked(list)]);
  };

  const sendToAgent = (text: string, picked: Picked[]) => {
    if (!agent) return;
    say(agent.id, { who: "you", text, files: picked.length ? picked.map((f) => f.name) : undefined });
    setReplying(true);
    const id = agent.id;
    const name = agent.name;
    setTimeout(() => {
      say(id, { who: "agent", text: `(Prototype) ${name} would answer this here, using its tools and rules.` });
      setReplying(false);
    }, 1500);
  };

  const deleteAgent = (id: string) => {
    remove(id);
    if (id === agent?.id) {
      const next = agents.find((a) => a.id !== id);
      if (next) select(next.id);
    }
  };

  const extra = agent ? (lines[agent.id] ?? []) : [];
  const voiceLines = extra.filter((l) => l.via === "voice");
  const status =
    current.phase === "connecting"
      ? `Connecting to ${agent?.name}...`
      : current.phase === "thinking"
        ? (current.status ?? "Thinking...")
        : current.phase === "talking"
          ? `${agent?.name} is talking`
          : muted
            ? "Muted"
            : "Listening";

  return (
    <Shell page="chat">
      {/* files can be dropped anywhere on the page; they land in the message box */}
      <div
        className="relative flex h-full"
        onDragEnter={(e) => {
          if (!hasFiles(e) || inCall || (!agent && !room)) return;
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (hasFiles(e) && !inCall) e.preventDefault();
        }}
        onDragLeave={() => {
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) {
            dragDepth.current = 0;
            setDragging(false);
          }
        }}
        onDrop={(e) => {
          if (!hasFiles(e) || inCall || (!agent && !room)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        {dragging && (agent || room) && (
          <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-8 backdrop-blur-sm">
            {/* shadcn Empty, outline (Simon picked B) */}
            <Empty className="h-full w-full border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PaperclipIcon />
                </EmptyMedia>
                <EmptyTitle>Drop files to attach</EmptyTitle>
                <EmptyDescription>They go into your message {room ? `in ${room.name}` : `to ${agent.name}`}.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        )}

        <aside className="flex w-72 flex-col overflow-auto border-r border-border px-3 py-4">
          <div className="flex items-center justify-between px-2">
            <span className="text-sm font-semibold">Cosign</span>
            {/* + : Pesto Dropdown Menu, each item opens its dialog */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="New" disabled={inCall}>
                  <Plus />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={() => setDialog("room")}>
                  <Hash /> New room
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDialog("join")}>
                  <Search /> Join public room
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDialog("agent")}>
                  <Bot /> New agent
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setDialog("mate")}>
                  <UserPlus /> Invite teammate
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <p className="mt-5 mb-1 px-2 text-xs font-medium text-muted-foreground">Rooms</p>
          <RoomList rooms={rooms} selected={room?.id ?? ""} onSelect={(id) => !inCall && selectRoom(id)} />

          <p className="mt-5 mb-1 px-2 text-xs font-medium text-muted-foreground">Agents</p>
          <AgentList agents={agents} selected={room ? "" : (agent?.id ?? "")} onSelect={(id) => !inCall && select(id)} onDelete={deleteAgent} />

          <NewRoomDialog
            open={dialog === "room"}
            onOpenChange={(o) => setDialog(o ? "room" : null)}
            team={team}
            agents={agents}
            onCreate={(r) => {
              addRoom(r);
              selectRoom(r.id);
            }}
          />
          <JoinRoomDialog
            open={dialog === "join"}
            onOpenChange={(o) => setDialog(o ? "join" : null)}
            rooms={rooms}
            onJoin={(id) => {
              addMembers(id, [ME]);
              selectRoom(id);
            }}
          />
          <NewAgentDialog
            open={dialog === "agent"}
            onOpenChange={(o) => setDialog(o ? "agent" : null)}
            onCreate={(a) => {
              add(a);
              select(a.id);
            }}
          />
          <InviteTeammateDialog open={dialog === "mate"} onOpenChange={(o) => setDialog(o ? "mate" : null)} onInvite={invite} />
        </aside>

        {room ? (
          <main className="flex min-w-0 flex-1 flex-col">
            <RoomView key={room.id} room={room} files={files} setFiles={setFiles} />
          </main>
        ) : agent ? (
          <main className="flex min-w-0 flex-1 flex-col">
            <header className="flex items-center gap-1.5 px-8 py-4 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{agent.name}</span>
              <StatusBadge status={agent.online || inCall ? "online" : "offline"} pulse={agent.online || inCall} className="ml-2">
                {inCall ? "In a call" : agent.online ? "Working" : "Idle"}
              </StatusBadge>
            </header>

            {inCall ? (
              /* the call: just the agent's orb, its voice level and what was last said */
              <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8">
                {/* the agent's own orb, grown to the centre; the call only changes its state (thinking, listening, talking) */}
                <AgentOrb hue={agent.hue} state={orbState[current.phase]} className="size-56 animate-in fade-in zoom-in-50 duration-700" />
                <ShimmeringText key={status} text={status} className="text-lg font-medium" repeat />
                <div className="flex h-16 items-center">
                  {current.phase === "connecting" || current.phase === "thinking" ? (
                    <Matrix rows={7} cols={7} frames={loader} fps={12} loop autoplay size={8} gap={3} palette={{ on: HUE_COLORS[agent.hue][0], off: "rgba(120,120,120,0.15)" }} ariaLabel="Working" />
                  ) : (
                    <Matrix rows={7} cols={20} mode="vu" levels={levels} size={8} gap={3} palette={{ on: HUE_COLORS[agent.hue][0], off: "rgba(120,120,120,0.15)" }} ariaLabel="Voice level" />
                  )}
                </div>
                <p className="h-10 max-w-md text-center text-sm text-muted-foreground">{voiceLines.slice(callFrom).at(-1)?.text}</p>
              </div>
            ) : agent.id === "clerk" || extra.length || replying ? (
              /* the thread: shadcn AI Elements Chat */
              <div className="min-h-0 flex-1">
                <MessageScrollerProvider autoScroll>
                  <MessageScroller>
                    <MessageScrollerViewport>
                      <MessageScrollerContent className="mx-auto max-w-2xl gap-6 px-8 py-4">
                        {agent.id === "clerk" && (
                          <>
                            <MessageScrollerItem messageId="s1" scrollAnchor>
                              <YouSaid line={{ who: "you", text: "Lena sent invoice 120 for the frontend work. Can you handle it?" }} />
                            </MessageScrollerItem>
                            <MessageScrollerItem messageId="s2">
                              <Message className="gap-3">
                                <MessageAvatar className="self-start">
                                  <AgentOrb hue={agent.hue} still className="size-8" />
                                </MessageAvatar>
                                <MessageContent className="gap-3">
                                  <Steps
                                    open
                                    title="Handled invoice 120 in 14 s"
                                    steps={["Read invoice 120 · paid $0.01", "Vendor check on Lena · paid $0.02 · risk low", "Name and address match the saved payee", "Drafted proposal #5"]}
                                  />
                                  <Words>
                                    {/* in a one-to-one chat there is no one to @, but sources are still cited inline */}
                                    <Said text="Drafted $2.40 to Lena for invoice 120 [[invoice]]. It needs one approval." members={[]} />
                                  </Words>
                                  <ApprovalRow
                                    icon={<Wallet />}
                                    title="Approve $2.40 to Lena?"
                                    description="Proposal #5 · you sign in your own wallet"
                                    approved="Approved · paid $2.40 to Lena"
                                    denied="Denied · nothing was paid"
                                    pending={["Connecting to your wallet…", "Waiting for your signature…", "Sending your approval to the treasury on Arc…"]}
                                  />
                                </MessageContent>
                              </Message>
                            </MessageScrollerItem>
                            <MessageScrollerItem messageId="s3" scrollAnchor>
                              <YouSaid line={{ who: "you", text: "Get a credit report on Lena before I approve." }} />
                            </MessageScrollerItem>
                            <MessageScrollerItem messageId="s4">
                              <Message className="gap-3">
                                <MessageAvatar className="self-start">
                                  <AgentOrb hue={agent.hue} still className="size-8" />
                                </MessageAvatar>
                                <MessageContent className="gap-3">
                                  <Steps title="Found a credit report API on QuickNode · $0.10" steps={[]} />
                                  {/* an action above the ask-first amount: shadcn Confirmation (Approve / Deny) */}
                                  <ApprovalRow
                                    icon={<Coins />}
                                    title="Pay $0.10 for a credit report on Lena?"
                                    description="QuickNode API · over the $0.05 ask-first limit"
                                    approved="Paid $0.10 · credit report on Lena: no issues found"
                                    denied="Denied · nothing was paid"
                                    pending={["Telling Clerk it's OK…", "Clerk is paying $0.10 from its own wallet…"]}
                                  />
                                </MessageContent>
                              </Message>
                            </MessageScrollerItem>
                          </>
                        )}
                        {/* typed and spoken lines, in one conversation */}
                        {extra.map((l, i) => (
                          <MessageScrollerItem key={i} messageId={`x${i}`} scrollAnchor={l.who === "you"}>
                            {l.who === "you" ? (
                              <YouSaid line={l} />
                            ) : (
                              <Message className="gap-3">
                                <MessageAvatar className="self-start">
                                  <AgentOrb hue={agent.hue} still className="size-8" />
                                </MessageAvatar>
                                <MessageContent>
                                  {l.via === "voice" && (
                                    <MessageHeader>
                                      <Tag variant="info">Voice</Tag>
                                    </MessageHeader>
                                  )}
                                  <p>{l.text}</p>
                                </MessageContent>
                              </Message>
                            )}
                          </MessageScrollerItem>
                        ))}
                        {replying && (
                          <MessageScrollerItem messageId="replying">
                            <Message className="gap-3">
                              <MessageAvatar className="self-start">
                                <AgentOrb hue={agent.hue} state="thinking" className="size-8" />
                              </MessageAvatar>
                              <MessageContent>
                                <Steps running title="Thinking" steps={[]} />
                              </MessageContent>
                            </Message>
                          </MessageScrollerItem>
                        )}
                      </MessageScrollerContent>
                    </MessageScrollerViewport>
                    <MessageScrollerButton />
                  </MessageScroller>
                </MessageScrollerProvider>
              </div>
            ) : (
              <EmptyState className="flex-1">
                <AgentOrb hue={agent.hue} className="size-14" />
                <EmptyStateTitle>Talk to {agent.name}</EmptyStateTitle>
                <EmptyStateDescription>{agent.job}</EmptyStateDescription>
              </EmptyState>
            )}

            <div className="px-8 pb-6">
              {inCall ? (
                <div className="mx-auto flex max-w-2xl items-center justify-center gap-3">
                  <Button variant="secondary" size="icon" aria-label={muted ? "Unmute" : "Mute"} onClick={() => setMuted((m) => !m)}>
                    {muted ? <MicOff /> : <Mic />}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      setInCall(false);
                    }}
                  >
                    <PhoneOff /> End call
                  </Button>
                </div>
              ) : (
                <Composer placeholder={`Message ${agent.name}`} files={files} setFiles={setFiles} onSend={sendToAgent} onTalk={startCall} busy={replying} />
              )}
            </div>
          </main>
        ) : (
          <main className="flex flex-1 items-center justify-center">
            <EmptyState>
              <EmptyStateTitle>No agents</EmptyStateTitle>
              <EmptyStateDescription>Create one to start.</EmptyStateDescription>
            </EmptyState>
          </main>
        )}
      </div>
    </Shell>
  );
}
