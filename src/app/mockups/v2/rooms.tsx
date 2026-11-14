"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, Globe, Hash, Lock, SearchIcon, UserPlus } from "lucide-react";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeaderText,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Stepper, StepperItem } from "@/components/ui/stepper";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { IconTile } from "@/components/icon-tile";
import { UserRow } from "@/components/user-row";
import { cn } from "@/lib/utils";
import type { Agent } from "./agents";
import { AgentOrb } from "./parts";
import type { Room, Teammate } from "./store";
import { AddressLine, personAddress } from "./money";

export const ME = "simon";
const GUIDELINES_MAX = 4096;

/** A room's mark: Pesto Icon Tile with # for public, a lock for private. */
export function RoomIcon({ room, size = "sm" }: { room: Pick<Room, "visibility">; size?: "sm" | "md" }) {
  return (
    <IconTile variant="soft" size={size} className={size === "sm" ? "size-8 rounded-[10px] [&_svg]:size-4" : undefined}>
      {room.visibility === "private" ? <Lock /> : <Hash />}
    </IconTile>
  );
}

/** The rooms you are in, as Pesto User Rows like the agents under them. */
export function RoomList({ rooms, selected, onSelect }: { rooms: Room[]; selected: string; onSelect: (id: string) => void }) {
  const mine = rooms.filter((r) => r.members.includes(ME));
  return (
    <div className="flex flex-col gap-1">
      {mine.map((r) => (
        /* the same row as an agent's (AgentList), so rooms and agents line up */
        <UserRow
          key={r.id}
          variant={r.id === selected ? "card" : "plain"}
          className={cn("cursor-pointer rounded-xl", r.id !== selected && "border border-transparent p-3 hover:bg-accent")}
          onClick={() => onSelect(r.id)}
          avatar={<RoomIcon room={r} />}
          label={r.name}
          sublabel={`${r.visibility === "private" ? "Private" : "Public"} · ${r.members.length} members`}
        />
      ))}
    </div>
  );
}

/** Who is in a room: teammates' initials and agents' orbs, in one shadcn Avatar Group. */
export function RoomMembers({ room, team, agents }: { room: Room; team: Teammate[]; agents: Agent[] }) {
  const people = team.filter((t) => room.members.includes(t.id));
  const bots = agents.filter((a) => room.members.includes(a.id));
  const shown: { id: string; person?: Teammate; agent?: Agent }[] = [
    ...people.map((p) => ({ id: p.id, person: p })),
    ...bots.map((a) => ({ id: a.id, agent: a })),
  ];
  return (
    <AvatarGroup>
      {shown.slice(0, 5).map((m) =>
        m.person ? (
          <Avatar key={m.id} size="sm">
            <AvatarFallback>{m.person.initials}</AvatarFallback>
          </Avatar>
        ) : (
          <Avatar key={m.id} size="sm">
            <AgentOrb hue={m.agent!.hue} still className="size-full" />
          </Avatar>
        ),
      )}
      {shown.length > 5 && <AvatarGroupCount>+{shown.length - 5}</AvatarGroupCount>}
    </AvatarGroup>
  );
}

/**
 * Pick people and agents: a search box, Select all / Reset, and one row per teammate or agent with a Pesto
 * Checkbox. Agents are invited like people. `exclude` hides who is already in.
 */
function MemberPicker({
  team,
  agents,
  value,
  onChange,
  exclude = [],
}: {
  team: Teammate[];
  agents: Agent[];
  value: string[];
  onChange: (ids: string[]) => void;
  exclude?: string[];
}) {
  const [q, setQ] = useState("");
  const all = useMemo(
    () => [
      ...team.filter((t) => !t.you).map((t) => ({ id: t.id, name: t.name, kind: "person" as const, t })),
      ...agents.map((a) => ({ id: a.id, name: a.name, kind: "agent" as const, a })),
    ].filter((m) => !exclude.includes(m.id)),
    [team, agents, exclude],
  );
  const shown = all.filter((m) => m.name.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (id: string, on: boolean) => onChange(on ? [...new Set([...value, id])] : value.filter((v) => v !== id));

  return (
    <div className="flex flex-col gap-3">
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput placeholder="Search people and agents" value={q} onChange={(e) => setQ(e.target.value)} />
      </InputGroup>
      <div className="rounded-xl border border-border">
        <div className="flex items-center justify-between px-3 py-2 text-sm">
          <button type="button" className="font-medium hover:underline" onClick={() => onChange([...new Set([...value, ...shown.map((m) => m.id)])])}>
            Select all
          </button>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onChange([])}>
            Reset
          </button>
        </div>
        <ItemGroup className="max-h-64 overflow-auto border-t border-border p-1">
          {shown.map((m) => (
            <Item key={m.id} size="sm" asChild className="cursor-pointer hover:bg-secondary/60">
              <label>
                <ItemActions>
                  <Checkbox checked={value.includes(m.id)} onCheckedChange={(c) => toggle(m.id, c === true)} aria-label={`Invite ${m.name}`} />
                </ItemActions>
                <ItemMedia>
                  {m.kind === "agent" ? (
                    <AgentOrb hue={m.a.hue} still className="size-8" />
                  ) : (
                    <Avatar>
                      <AvatarFallback>{m.t.initials}</AvatarFallback>
                    </Avatar>
                  )}
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {m.name}
                    {m.kind === "agent" ? <Tag variant="info">Agent</Tag> : m.t.invited ? <Tag>Invited</Tag> : null}
                  </ItemTitle>
                  <ItemDescription className="flex items-center gap-1">
                    {m.kind === "agent" ? (
                      m.a.job
                    ) : (
                      <>
                        {m.t.role} · <AddressLine address={m.t.address ?? personAddress(m.t.id)} label={`${m.name}'s wallet address`} />
                      </>
                    )}
                  </ItemDescription>
                </ItemContent>
              </label>
            </Item>
          ))}
          {shown.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">No one matches.</p>}
        </ItemGroup>
      </div>
      <p className="text-sm text-muted-foreground">{value.length} selected</p>
    </div>
  );
}

const STEPS = [
  { title: "Visibility", description: "Choose who can find this room." },
  { title: "Details", description: "Name the room and say what it's for. Agents in the room follow these guidelines." },
  { title: "Invite", description: "Invite people and agents to start working together." },
];

/** Create a room in three steps: public or private, name and guidelines, then who to invite. */
export function NewRoomDialog({
  open,
  onOpenChange,
  team,
  agents,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: Teammate[];
  agents: Agent[];
  onCreate: (room: Room) => void;
}) {
  const [step, setStep] = useState(0);
  const [visibility, setVisibility] = useState<Room["visibility"]>("public");
  const [name, setName] = useState("");
  const [guidelines, setGuidelines] = useState("");
  const [invite, setInvite] = useState<string[]>([]);
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const reset = () => {
    setStep(0);
    setVisibility("public");
    setName("");
    setGuidelines("");
    setInvite([]);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogHeaderText>
            <DialogTitle>Create room</DialogTitle>
            <DialogDescription>{STEPS[step].description}</DialogDescription>
          </DialogHeaderText>
        </DialogHeader>
        <DialogBody>
          {step === 0 && (
            <RadioGroup value={visibility} onValueChange={(v) => setVisibility(v as Room["visibility"])} className="gap-3">
              {(
                [
                  { value: "public", icon: <Globe />, title: "Public room", text: "Everyone in the workspace can find and join it." },
                  { value: "private", icon: <Lock />, title: "Private room", text: "Only the people and agents you invite." },
                ] as const
              ).map((o) => (
                /* shadcn Item as a choice card around Pesto's radio */
                <Item key={o.value} variant="outline" asChild className="cursor-pointer has-data-checked:border-selected has-data-checked:bg-secondary/40">
                  <label>
                    <ItemMedia variant="icon">{o.icon}</ItemMedia>
                    <ItemContent>
                      <ItemTitle>{o.title}</ItemTitle>
                      <ItemDescription>{o.text}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <RadioGroupItem value={o.value} aria-label={o.title} />
                    </ItemActions>
                  </label>
                </Item>
              ))}
            </RadioGroup>
          )}

          {step === 1 && (
            <div className="flex flex-col gap-5">
              <div className="grid gap-2">
                <Label htmlFor="room-name">Room name</Label>
                <div className="flex items-center gap-2">
                  <RoomIcon room={{ visibility }} />
                  <Input id="room-name" placeholder="e.g. vendor-payments" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="room-guidelines">Guidelines</Label>
                <Textarea
                  id="room-guidelines"
                  rows={4}
                  maxLength={GUIDELINES_MAX}
                  placeholder="What this room is for, and the rules people and agents follow here"
                  value={guidelines}
                  onChange={(e) => setGuidelines(e.target.value)}
                />
                <span className="text-right text-xs text-muted-foreground">
                  {guidelines.length}/{GUIDELINES_MAX}
                </span>
              </div>
            </div>
          )}

          {step === 2 && <MemberPicker team={team} agents={agents} value={invite} onChange={setInvite} />}
        </DialogBody>
        <DialogFooter className="items-center sm:justify-between">
          <Stepper variant="dots" activeStep={step} aria-label="Create room steps">
            {STEPS.map((s) => (
              <StepperItem key={s.title} title={s.title} />
            ))}
          </Stepper>
          <div className="flex gap-2">
            {step === 0 ? (
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setStep((s) => s - 1)}>
                <ArrowLeft /> Back
              </Button>
            )}
            {step < 2 ? (
              <Button disabled={step === 1 && !slug} onClick={() => setStep((s) => s + 1)}>
                Next
              </Button>
            ) : (
              <Button
                onClick={() => {
                  onCreate({ id: `${slug}-${Date.now().toString(36)}`, name: slug, visibility, guidelines: guidelines.trim(), members: [ME, ...invite] });
                  onOpenChange(false);
                  reset();
                }}
              >
                Create
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Public rooms you are not in yet: Pesto Command (search + list); choosing one joins it. */
export function JoinRoomDialog({
  open,
  onOpenChange,
  rooms,
  onJoin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rooms: Room[];
  onJoin: (id: string) => void;
}) {
  const open_ = rooms.filter((r) => r.visibility === "public" && !r.members.includes(ME));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogHeaderText>
            <DialogTitle>Join a public room</DialogTitle>
            <DialogDescription>Public rooms anyone in the workspace can join.</DialogDescription>
          </DialogHeaderText>
        </DialogHeader>
        <DialogBody>
          <Command className="rounded-xl border border-border">
            <CommandInput placeholder="Search public rooms" />
            <CommandList>
              <CommandEmpty>No public rooms to join.</CommandEmpty>
              <CommandGroup>
                {open_.map((r) => (
                  <CommandItem
                    key={r.id}
                    value={`${r.name} ${r.guidelines}`}
                    onSelect={() => {
                      onJoin(r.id);
                      onOpenChange(false);
                    }}
                  >
                    <RoomIcon room={r} />
                    <div className="flex min-w-0 flex-col">
                      <span className="font-medium">{r.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {r.members.length} members · {r.guidelines}
                      </span>
                    </div>
                    <span className="ml-auto text-xs text-muted-foreground">Join</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** Add people or agents to a room you are in. */
export function InviteToRoomDialog({
  open,
  onOpenChange,
  room,
  team,
  agents,
  onInvite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: Room;
  team: Teammate[];
  agents: Agent[];
  onInvite: (ids: string[]) => void;
}) {
  const [pick, setPick] = useState<string[]>([]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setPick([]);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogHeaderText>
            <DialogTitle>Invite to {room.name}</DialogTitle>
            <DialogDescription>People and agents you invite can read and write here.</DialogDescription>
          </DialogHeaderText>
        </DialogHeader>
        <DialogBody>
          <MemberPicker team={team} agents={agents} value={pick} onChange={setPick} exclude={room.members} />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!pick.length}
            onClick={() => {
              onInvite(pick);
              onOpenChange(false);
              setPick([]);
            }}
          >
            Invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Invite a person to the workspace by wallet address (sign-in is wallet only). They show as Invited until they sign in. */
export function InviteTeammateDialog({
  open,
  onOpenChange,
  onInvite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvite: (t: Teammate) => void;
}) {
  const [name, setName] = useState("");
  const [wallet, setWallet] = useState("");
  const [role, setRole] = useState("Member");
  const valid = name.trim() && /^0x[0-9a-fA-F]{40}$/.test(wallet.trim());
  const reset = () => {
    setName("");
    setWallet("");
    setRole("Member");
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogHeaderText>
            <DialogTitle>Invite a teammate</DialogTitle>
            <DialogDescription>They join when they sign in with this wallet.</DialogDescription>
          </DialogHeaderText>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-5">
          <div className="grid gap-2">
            <Label htmlFor="mate-name">Name</Label>
            <Input id="mate-name" placeholder="Alex" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mate-wallet">Wallet address</Label>
            <Input id="mate-wallet" placeholder="0x…" value={wallet} onChange={(e) => setWallet(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Role</Label>
            <RadioGroup value={role} onValueChange={setRole} className="gap-3">
              {[
                { value: "Member", text: "Talks to agents and joins rooms." },
                { value: "Approver", text: "Can also approve treasury payments." },
              ].map((o) => (
                <Item key={o.value} variant="outline" size="sm" asChild className="cursor-pointer has-data-checked:border-selected has-data-checked:bg-secondary/40">
                  <label>
                    <ItemContent>
                      <ItemTitle>{o.value}</ItemTitle>
                      <ItemDescription>{o.text}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <RadioGroupItem value={o.value} aria-label={o.value} />
                    </ItemActions>
                  </label>
                </Item>
              ))}
            </RadioGroup>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              const w = wallet.trim();
              const n = name.trim();
              onInvite({
                id: `mate-${Date.now().toString(36)}`,
                name: n,
                initials: n.slice(0, 2).toUpperCase(),
                wallet: `${w.slice(0, 6)}…${w.slice(-4)}`,
                address: w,
                role,
                invited: true,
              });
              onOpenChange(false);
              reset();
            }}
          >
            <UserPlus /> Invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A room you are not in (a public one reached by link): what it is, and Join. */
export function JoinRoomEmpty({ room, onJoin }: { room: Room; onJoin: () => void }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia>
          <RoomIcon room={room} size="md" />
        </EmptyMedia>
        <EmptyTitle>{room.name}</EmptyTitle>
        <EmptyDescription>{room.guidelines || "A public room."}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onJoin}>Join room</Button>
      </EmptyContent>
    </Empty>
  );
}
