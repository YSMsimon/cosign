"use client";

/**
 * Rooms and agents, for real: the left side lists the rooms (still the design board's sample: rooms aren't wired) and
 * the agents you can talk to; the middle is your conversation with the agent you picked, live as it works; the right
 * is its wallet and its place on the treasury. Same components and words as /mockups/v2/session.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Bot, Hash, Info, Mic, MicOff, PaperclipIcon, PhoneOff, Plus, RefreshCw, Search, UserPlus } from "lucide-react";
import { loader, Matrix } from "@/components/ui/matrix";
import type { AgentState } from "@/components/ui/orb";
import { ShimmeringText } from "@/components/ui/shimmering-text";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { EmptyState, EmptyStateDescription, EmptyStateTitle } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { api, chatTurn, type Role } from "@/lib/client/api";
import { invalidate, setData, useData } from "@/lib/client/data";
import { AgentAbout } from "../../mockups/v2/agent-about";
import { AgentList, NewAgentDialog, type Agent } from "../../mockups/v2/agents";
import { Composer, toPicked, type Picked } from "../../mockups/v2/composer";
import { GROK_BOT, mentionedIn, type Member } from "../../mockups/v2/mentions";
import { AgentOrb, HUE_COLORS } from "../../mockups/v2/parts";
import { RoomView } from "../../mockups/v2/room-view";
import { InviteTeammateDialog, JoinRoomDialog, ME, NewRoomDialog, RoomList } from "../../mockups/v2/rooms";
import { useAgents as useSampleAgents, useRooms, useTeam as useSampleTeam } from "../../mockups/v2/store";
import { aboutInfo, hueOf, useAgentsData } from "../agents-data";
import { AppShell, initialsOf } from "../app-shell";
import { useCosign, useLive } from "../cosign";
import { foldRunEvent } from "./steps";
import { buildTurns, ThreadView, type LiveTurn } from "./thread-view";
import { useChatExtras, useToolCards } from "./extras";
import { ChatActionsContext } from "./actions";
import { ToolCard } from "./cards";
import { useRoomAsk } from "./room-ask";
import { useRealRooms } from "./rooms-data";
import { useVoiceCall, type Phase } from "./voice";

const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
const orbState: Record<Phase, AgentState> = { connecting: "thinking", listening: "listening", thinking: "thinking", talking: "talking" };

/** The role an invite gets: "Member" talks to agents (Agent user), "Approver" can also approve. */
const roleFor = (roles: Role[], pick: string) => (pick === "Approver" ? roles.find((r) => r.key === "approver") : roles.find((r) => r.name === "Agent user") ?? roles.find((r) => !r.system));

export function ChatView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { wsId, ws, can, address } = useCosign();
  const agentsData = useAgentsData();
  const { rooms: savedRooms, add: addRoom, addMembers } = useRooms();
  const { team: sampleTeam } = useSampleTeam();
  const { agents: sampleAgents } = useSampleAgents();
  const agents = agentsData.usable;
  const agent = agents.find((a) => a.id === params.get("agent")) ?? agents[0];
  const view = agentsData.views.find((a) => a.id === agent?.id);
  const select = (id: string) => router.replace(`${pathname}?agent=${id}`);
  const selectRoom = (id: string) => router.replace(`${pathname}?room=${id}`);
  const [dialog, setDialog] = useState<null | "room" | "join" | "agent" | "mate">(null);
  const [showAbout, setShowAbout] = useState(true);
  const [files, setFiles] = useState<Picked[]>([]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const roomAsk = useRoomAsk(); // in a room, the agents named are your real agents
  const [notice, setNotice] = useState<{ title: string; text: string } | null>(null);

  const thread = useData(agent ? `thread:${agent.id}` : null, () => api.thread(agent!.id));
  const detail = useData(agent ? `agent:${agent.id}` : null, () => api.agent(agent!.id));
  const teamData = useData(`team:${wsId}`, () => api.team(wsId));
  // rooms are kept in the browser, but who is in them is real: your agents and the workspace's people
  const sample = useMemo(() => ({ agents: sampleAgents, team: sampleTeam }), [sampleAgents, sampleTeam]);
  const real = useRealRooms({ rooms: savedRooms, agents, people: teamData.data?.people, address, sample });
  const rooms = real.rooms;
  const room = rooms.find((r) => r.id === params.get("room"));
  const roles = useData(can("members.manage") ? `roles:${wsId}` : null, () => api.roles(wsId));

  // who @ can name in a message: the other agents, Grok Bot (runs this agent's job in the background), then people
  const agentId = agent?.id;
  const views = agentsData.views;
  const members: Member[] = useMemo(
    () => [
      ...(teamData.data?.agents ?? [])
        .filter((a) => a.id !== agentId)
        .map((a): Member => {
          const v = views.find((x) => x.id === a.id);
          return { id: a.id, name: a.name, kind: "agent", sub: a.job, address: v?.wallet ?? "", hue: hueOf({ id: a.id, hue: v?.hue }) };
        }),
      GROK_BOT,
      ...(teamData.data?.people ?? [])
        .filter((p) => p.address !== address)
        .map((p): Member => ({ id: p.id, name: p.name, kind: "person", sub: p.role, address: p.address, initials: initialsOf(p.name, p.address) })),
    ],
    [teamData.data, views, agentId, address],
  );

  // to draw @mentions in what was said, everyone counts, you included (you just can't @ yourself)
  const everyone: Member[] = useMemo(() => {
    const me = teamData.data?.people.find((p) => p.address === address);
    return me ? [...members, { id: me.id, name: me.name, kind: "person", sub: me.role, address: me.address, initials: initialsOf(me.name, me.address) }] : members;
  }, [members, teamData.data, address]);
  const extras = useChatExtras(agent, view, everyone);
  const cards = useToolCards(agent);
  const voice = useVoiceCall(agent);
  // a payment drafted by voice opens its cosign card in this call (the server says which session it came from)
  const [callDraft, setCallDraft] = useState<{ session: string; proposalId: number } | null>(null);
  useLive(
    "proposal.drafted",
    useCallback((d: Record<string, unknown>) => {
      if (d.taskId && d.proposalId !== undefined) setCallDraft({ session: String(d.taskId), proposalId: Number(d.proposalId) });
    }, []),
  );

  const addFiles = (list: FileList | null) => {
    if (list?.length) setFiles((cur) => [...cur, ...toPicked(list)]);
  };

  const send = useCallback(
    async (text: string, picked: Picked[]) => {
      if (!agent) return;
      // files can't be sent to the agent yet: say so in the message instead of pretending they went
      const note = picked.length ? `\n\n(Attached here but not sent: ${picked.map((f) => f.name).join(", ")})` : "";
      // "@Grok Bot …" hands the job to this agent's background run (its Grok Bot routine, or our loop when none is connected)
      if (mentionedIn(text, [GROK_BOT]).length) {
        const job = text.replace(/@Grok Bot\b/gi, "").trim();
        try {
          await api.startTask(agent.id, job || text);
          invalidate(`tasks:${wsId}`);
        } catch (e) {
          setNotice({ title: "Couldn't start the background job", text: (e as Error).message });
        }
        return;
      }
      const startedAt = Date.now();
      setLive({ prompt: text + note, steps: [], running: true, startedAt });
      try {
        // steps and the answer's words appear as the agent works (the words stream in as Grok writes them)
        const done = await chatTurn(agent.id, text, (s) => setLive((cur) => (cur ? foldRunEvent(cur, s) : cur)));
        setLive((cur) => (cur ? { ...cur, running: false, endedAt: Date.now(), text: done.finalText } : cur));
        // the saved thread now has the whole turn (with its cards); swap the live copy for it
        const fresh = await api.thread(agent.id);
        setData(`thread:${agent.id}`, () => fresh);
        invalidate(`agent:${agent.id}`, `proposals:`, `approvals:`, `funding:`, `spend:`, `tasks:`);
        setLive(null);
      } catch (e) {
        setLive((cur) => (cur ? { ...cur, running: false, endedAt: Date.now(), error: (e as Error).message } : cur));
      }
    },
    [agent, wsId],
  );

  const turns = thread.data ? buildTurns(thread.data.messages) : [];

  return (
    <AppShell page="chat">
      {/* files can be dropped anywhere on the page; they land in the message box */}
      <div
        className="relative flex h-full"
        onDragEnter={(e) => {
          if (!hasFiles(e) || (!agent && !room)) return;
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (hasFiles(e)) e.preventDefault();
        }}
        onDragLeave={() => {
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) {
            dragDepth.current = 0;
            setDragging(false);
          }
        }}
        onDrop={(e) => {
          if (!hasFiles(e) || (!agent && !room)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        {dragging && (agent || room) && (
          <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-8 backdrop-blur-sm">
            <Empty className="h-full w-full border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PaperclipIcon />
                </EmptyMedia>
                <EmptyTitle>Drop files to attach</EmptyTitle>
                <EmptyDescription>They go into your message {room ? `in ${room.name}` : `to ${agent?.name}`}.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        )}

        <aside className="flex w-72 flex-col overflow-auto border-r border-border px-3 py-4">
          <div className="flex items-center justify-between px-2">
            <span className="text-sm font-semibold">{ws.workspace.name}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="New">
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
                <DropdownMenuItem onSelect={() => setDialog("agent")} disabled={!can("agents.build") && !can("agents.manage")}>
                  <Bot /> New agent
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setDialog("mate")} disabled={!can("members.manage")}>
                  <UserPlus /> Invite teammate
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <p className="mt-5 mb-1 px-2 text-xs font-medium text-muted-foreground">Rooms</p>
          <RoomList rooms={rooms} selected={room?.id ?? ""} onSelect={(id) => !voice.inCall && selectRoom(id)} />

          <p className="mt-5 mb-1 px-2 text-xs font-medium text-muted-foreground">Agents</p>
          {agentsData.loading ? (
            <div className="flex flex-col gap-2" aria-label="Loading agents">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 rounded-xl" />
              ))}
            </div>
          ) : agentsData.error ? (
            <Alert
              variant="destructive"
              action={
                <Button size="icon-sm" variant="ghost" aria-label="Try again" onClick={() => agentsData.reload()}>
                  <RefreshCw />
                </Button>
              }
            >
              <AlertTitle>Couldn&apos;t load the agents</AlertTitle>
              <AlertDescription>{agentsData.error.message}</AlertDescription>
            </Alert>
          ) : (
            <AgentList
              agents={agents}
              selected={room ? "" : (agent?.id ?? "")}
              onSelect={(id) => !voice.inCall && select(id)}
              onDelete={async (id) => {
                try {
                  await api.retire(id);
                  invalidate(`agents:${wsId}`, `team:${wsId}`);
                  if (id === agent?.id) router.replace(pathname);
                } catch (e) {
                  setNotice({ title: "Couldn't delete the agent", text: (e as Error).message });
                }
              }}
            />
          )}

          {notice && (
            <Alert variant="destructive" className="mt-4" action={<Button size="xs" variant="ghost" onClick={() => setNotice(null)}>Dismiss</Button>}>
              <AlertTitle>{notice.title}</AlertTitle>
              <AlertDescription>{notice.text}</AlertDescription>
            </Alert>
          )}

          <NewRoomDialog
            open={dialog === "room"}
            onOpenChange={(o) => setDialog(o ? "room" : null)}
            team={real.team}
            agents={real.agents}
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
            onCreate={async (a: Agent) => {
              try {
                const r = await api.createAgent(wsId, {
                  name: a.name,
                  prompt: a.job === "New agent" ? `${a.name}: a new agent.` : a.job,
                  visibility: can("agents.manage") ? "team" : "private",
                  hue: a.hue,
                });
                invalidate(`agents:${wsId}`, `team:${wsId}`);
                select(r.agent.id);
              } catch (e) {
                setNotice({ title: "Couldn't create the agent", text: (e as Error).message });
              }
            }}
          />
          <InviteTeammateDialog
            open={dialog === "mate"}
            onOpenChange={(o) => setDialog(o ? "mate" : null)}
            onInvite={async (t) => {
              const role = roleFor(roles.data?.roles ?? [], t.role);
              try {
                if (!role) throw new Error("No role to give them; reload and try again.");
                await api.invite(wsId, { address: t.address ?? "", roleId: role.id, title: t.name });
                invalidate(`members:${wsId}`, `team:${wsId}`);
              } catch (e) {
                setNotice({ title: "Couldn't invite them", text: (e as Error).message });
              }
            }}
          />
        </aside>

        {room ? (
          <main className="flex min-w-0 flex-1 flex-col">
            <RoomView key={room.id} room={room} files={files} setFiles={setFiles} ask={roomAsk} people={real} scope={wsId} />
          </main>
        ) : agent ? (
          <main className="flex min-w-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              <header className="flex items-center gap-1.5 px-8 py-4 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{agent.name}</span>
                <StatusBadge status={agent.online || live?.running || voice.inCall ? "online" : "offline"} pulse={agent.online || !!live?.running || voice.inCall} className="ml-2">
                  {voice.inCall ? "In a call" : agent.online || live?.running ? "Working" : "Idle"}
                </StatusBadge>
                <Button
                  variant={showAbout ? "secondary" : "ghost"}
                  size="icon-sm"
                  className="ml-auto"
                  aria-label={`About ${agent.name}`}
                  aria-pressed={showAbout}
                  onClick={() => setShowAbout((s) => !s)}
                >
                  <Info />
                </Button>
              </header>

              {voice.inCall ? (
                /* the call: just the agent's orb, its voice level and what was last said */
                <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8">
                  <AgentOrb hue={agent.hue} state={orbState[voice.phase]} className="size-56 animate-in fade-in zoom-in-50 duration-700" />
                  <ShimmeringText key={voice.statusText} text={voice.statusText} className="text-lg font-medium" repeat />
                  <div className="flex h-16 items-center">
                    {voice.phase === "connecting" || voice.phase === "thinking" ? (
                      <Matrix rows={7} cols={7} frames={loader} fps={12} loop autoplay size={8} gap={3} palette={{ on: HUE_COLORS[agent.hue][0], off: "rgba(120,120,120,0.15)" }} ariaLabel="Working" />
                    ) : (
                      <Matrix rows={7} cols={20} mode="vu" levels={voice.levels} size={8} gap={3} palette={{ on: HUE_COLORS[agent.hue][0], off: "rgba(120,120,120,0.15)" }} ariaLabel="Voice level" />
                    )}
                  </div>
                  <p className="h-10 max-w-md text-center text-sm text-muted-foreground" aria-live="polite">
                    {voice.caption}
                  </p>
                  {callDraft && callDraft.session === voice.sessionId && (
                    <div className="w-full max-w-md">
                      <ToolCard agent={agent} call={{ name: "propose_payment", args: {}, result: { proposalId: String(callDraft.proposalId) }, t: new Date(0).toISOString() }} />
                    </div>
                  )}
                </div>
              ) : thread.loading ? (
                <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-8 py-4" aria-label="Loading the conversation">
                  <Skeleton className="ml-auto h-10 w-2/3 rounded-2xl" />
                  <Skeleton className="h-24 w-3/4 rounded-2xl" />
                </div>
              ) : thread.error ? (
                <div className="mx-auto w-full max-w-2xl flex-1 px-8 py-4">
                  <Alert
                    variant="destructive"
                    action={
                      <Button size="sm" variant="outline" onClick={() => thread.reload()}>
                        <RefreshCw /> Try again
                      </Button>
                    }
                  >
                    <AlertTitle>Couldn&apos;t load the conversation</AlertTitle>
                    <AlertDescription>{thread.error.message}</AlertDescription>
                  </Alert>
                </div>
              ) : turns.length || live || extras.length ? (
                <ChatActionsContext.Provider value={{ say: (t) => void send(t, []) }}>
                  <ThreadView agent={agent} turns={turns} live={live} extras={extras} members={everyone} cards={cards} />
                </ChatActionsContext.Provider>
              ) : (
                <EmptyState className="flex-1">
                  <AgentOrb hue={agent.hue} className="size-14" />
                  <EmptyStateTitle>Talk to {agent.name}</EmptyStateTitle>
                  <EmptyStateDescription>{agent.job}</EmptyStateDescription>
                </EmptyState>
              )}

              <div className="px-8 pb-6">
                {voice.error && (
                  <Alert variant="destructive" className="mx-auto mb-3 max-w-2xl" action={<Button size="xs" variant="ghost" onClick={voice.clearError}>Dismiss</Button>}>
                    <AlertTitle>The call didn&apos;t work</AlertTitle>
                    <AlertDescription>{voice.error}</AlertDescription>
                  </Alert>
                )}
                {voice.inCall ? (
                  <div className="mx-auto flex max-w-2xl items-center justify-center gap-3">
                    <Button variant="secondary" size="icon" aria-label={voice.muted ? "Unmute" : "Mute"} onClick={() => voice.setMuted(!voice.muted)}>
                      {voice.muted ? <MicOff /> : <Mic />}
                    </Button>
                    <Button variant="destructive" onClick={voice.end}>
                      <PhoneOff /> End call
                    </Button>
                  </div>
                ) : (
                  <Composer
                    placeholder={`Message ${agent.name}`}
                    files={files}
                    setFiles={setFiles}
                    onSend={(t, p) => void send(t, p)}
                    onTalk={voice.configured ? () => void voice.start() : undefined}
                    busy={!!live?.running}
                    mentions={members}
                  />
                )}
              </div>
            </div>
            {showAbout && <AgentAbout agent={agent} onClose={() => setShowAbout(false)} info={aboutInfo(detail.data?.agent, ws, view?.wallet ?? "")} />}
          </main>
        ) : agentsData.loading ? (
          <main className="flex-1" />
        ) : (
          <main className="flex flex-1 items-center justify-center">
            <EmptyState>
              <EmptyStateTitle>No agents</EmptyStateTitle>
              <EmptyStateDescription>Create one to start.</EmptyStateDescription>
            </EmptyState>
          </main>
        )}
      </div>
    </AppShell>
  );
}
