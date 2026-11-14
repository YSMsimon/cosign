"use client";

import { useState } from "react";
import { Lock, UserPlus, Wallet } from "lucide-react";
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
import { roomMembers, Said } from "./mentions";
import { ApprovalRow, Steps } from "./parts";
import { InviteToRoomDialog, JoinRoomEmpty, ME, RoomIcon, RoomMembers } from "./rooms";
import { roomKey, useAgents, useLines, useRooms, useTeam, type Room } from "./store";
import { AgentSaid, PersonSaid, YouSaid } from "./thread";

/** Agents in the room named with @ in a message, e.g. "@Clerk can you pay this?" */
function mentioned(text: string, names: { id: string; name: string }[]) {
  const said = [...text.matchAll(/@([\w-]+)/g)].map((m) => m[1].toLowerCase());
  return names.filter((a) => said.includes(a.name.toLowerCase()));
}

/**
 * A room: a shared conversation for teammates and agents. Everyone in it sees every message; an agent answers when
 * someone names it with @, following the room's guidelines. Payments an agent drafts here are approved here too.
 * Prototype: rooms and messages live in the browser (./store).
 */
export function RoomView({ room, files, setFiles }: { room: Room; files: Picked[]; setFiles: (update: (cur: Picked[]) => Picked[]) => void }) {
  const { agents } = useAgents();
  const { team } = useTeam();
  const { addMembers } = useRooms();
  const { lines, say } = useLines();
  const [inviting, setInviting] = useState(false);
  const [replying, setReplying] = useState<string | null>(null);

  const extra = lines[roomKey(room.id)] ?? [];
  const roomAgents = agents.filter((a) => room.members.includes(a.id));
  const members = roomMembers(room, team, agents);
  const replier = agents.find((a) => a.id === replying);
  const seeded = room.id === "finance";

  if (!room.members.includes(ME)) {
    return <JoinRoomEmpty room={room} onJoin={() => addMembers(room.id, [ME])} />;
  }

  const send = (text: string, picked: Picked[]) => {
    say(roomKey(room.id), { who: "you", text, files: picked.length ? picked.map((f) => f.name) : undefined });
    const [agent] = mentioned(text, roomAgents);
    if (!agent) return;
    setReplying(agent.id);
    setTimeout(() => {
      say(roomKey(room.id), { who: "agent", author: agent.id, text: `(Prototype) ${agent.name} would answer here for #${room.name}, following its guidelines.` });
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

      {seeded || extra.length || replying ? (
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
                          <div>
                            <Said
                              text="Drafted $2.40 to Lena for invoice 120 [[invoice]]. Her address matches the saved payee [[payee]]. @Auditor can you review it before Priya approves?"
                              members={members}
                            />
                          </div>
                        </AgentSaid>
                      </MessageScrollerItem>
                      <MessageScrollerItem messageId="r3">
                        <AgentSaid name="Auditor" hue="violet">
                          <Steps
                            title="Reviewed proposal #5 in 6 s"
                            steps={["Read proposal #5 onchain", "Compared it with invoice 120", "Lena's history · 3 paid, none disputed"]}
                          />
                          <div>
                            <Said
                              text="The amount and payee match the invoice [[invoice]] and the proposal onchain [[proposal]]. @Priya it's ready for you."
                              members={members}
                            />
                          </div>
                          <ApprovalRow
                            icon={<Wallet />}
                            title="Approve $2.40 to Lena?"
                            description="Proposal #5 · you sign in your own wallet"
                            approved="Approved · paid $2.40 to Lena"
                            denied="Denied · nothing was paid"
                          />
                        </AgentSaid>
                      </MessageScrollerItem>
                    </>
                  )}
                  {extra.map((l, i) => {
                    const agent = agents.find((a) => a.id === l.author);
                    const mate = team.find((t) => t.id === l.author);
                    return (
                      <MessageScrollerItem key={i} messageId={`x${i}`} scrollAnchor={l.who === "you"}>
                        {l.who === "you" ? (
                          <YouSaid line={l}>
                            <Said text={l.text} members={members} />
                          </YouSaid>
                        ) : agent ? (
                          <AgentSaid name={agent.name} hue={agent.hue}>
                            <div>
                              <Said text={l.text} members={members} />
                            </div>
                          </AgentSaid>
                        ) : (
                          <PersonSaid name={mate?.name ?? "Someone"} initials={mate?.initials ?? "?"} line={l}>
                            <Said text={l.text} members={members} />
                          </PersonSaid>
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
          busy={replying !== null}
          mentions={members}
        />
      </div>

      <InviteToRoomDialog open={inviting} onOpenChange={setInviting} room={room} team={team} agents={agents} onInvite={(ids) => addMembers(room.id, ids)} />
    </>
  );
}
