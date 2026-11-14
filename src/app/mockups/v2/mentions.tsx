"use client";

import { Fragment } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tag } from "@/components/ui/tag";
import type { OrbHue } from "@/components/orb-avatar";
import type { Agent } from "./agents";
import { AgentOrb } from "./parts";
import type { Room, Teammate } from "./store";

/** Someone you can @: an agent or a teammate. */
export type Member = { id: string; name: string; kind: "agent" | "person"; sub: string; hue?: OrbHue; initials?: string };

export const agentMember = (a: Agent): Member => ({ id: a.id, name: a.name, kind: "agent", sub: a.job, hue: a.hue });
export const personMember = (t: Teammate): Member => ({ id: t.id, name: t.name, kind: "person", sub: `${t.role} · ${t.wallet}`, initials: t.initials });

/** Everyone in a room you could @ (not yourself): agents first, then people. */
export function roomMembers(room: Room, team: Teammate[], agents: Agent[]): Member[] {
  return [
    ...agents.filter((a) => room.members.includes(a.id)).map(agentMember),
    ...team.filter((t) => room.members.includes(t.id) && !t.you).map(personMember),
  ];
}

/** Who is @named in a piece of text. */
export const mentionedIn = (text: string, members: Member[]) =>
  members.filter((m) => new RegExp(`(^|\\s)@${m.name}(?![\\w-])`, "i").test(text));

/** A member's face: the agent's orb or the teammate's initials. */
export function MemberFace({ m, className = "size-6" }: { m: Member; className?: string }) {
  return m.kind === "agent" ? (
    <AgentOrb hue={m.hue ?? "blue"} still className={className} />
  ) : (
    /* default size, so `className` sets it (the sm size's data selector would win over it) */
    <Avatar className={className}>
      <AvatarFallback className="text-[0.55rem]">{m.initials}</AvatarFallback>
    </Avatar>
  );
}

/**
 * An @ in a message (Simon picked the Pesto Tag): the member's face on the left of the name, and a click opens a
 * card about who it is (Pesto Popover).
 */
export function MentionChip({ m }: { m: Member }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Tag
          variant="info"
          size="sm"
          role="button"
          tabIndex={0}
          leading={<MemberFace m={m} className="size-4" />}
          className="cursor-pointer align-middle"
        >
          @{m.name}
        </Tag>
      </PopoverTrigger>
      <PopoverContent className="w-64 flex-row items-center gap-3">
        <MemberFace m={m} className="size-9" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-1.5 font-medium">
            {m.name}
            {m.kind === "agent" && <Tag variant="info">Agent</Tag>}
          </div>
          <p className="truncate text-xs text-muted-foreground">{m.sub}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Where an agent got something: a file, a saved record or a page. */
export type Source = { label: string; title: string; description: string; url?: string };

/**
 * shadcn AI Elements Inline Citation: a secondary xs Button in the sentence it supports. Its card opens on click
 * (Pesto Popover; Simon's call) instead of on hover.
 */
export function Citation({ source }: { source: Source }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="xs" className="align-middle">
          {source.label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="flex w-64 flex-col gap-1">
        <div className="font-medium">{source.title}</div>
        <p className="text-muted-foreground">{source.description}</p>
        {source.url && (
          <a href={source.url} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
            {new URL(source.url).hostname}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The sources the sample conversations cite. */
export const SOURCES: Record<string, Source> = {
  invoice: {
    label: "invoice-120.pdf",
    title: "Invoice 120 · Lena",
    description: "Frontend work, week 46. $2.40. Uploaded by Priya.",
  },
  payee: {
    label: "Saved payees",
    title: "Lena (contractor)",
    description: "0x7797…f1e7, added by Simon on Nov 12.",
  },
  proposal: {
    label: "explorer.testnet.arc.io",
    title: "Proposal #5 on Arc",
    description: "Treasury proposal: $2.40 USDC to 0x7797…f1e7, 0 of 1 approvals.",
    url: "https://explorer.testnet.arc.io/address/0xb496FD2D5b29A5b12Ee3d30e7359578fec86e62c",
  },
};

/**
 * A message's text with its @mentions and [[source]] citations drawn inline. "@Name" becomes a mention when Name is
 * someone in `members`; "[[key]]" becomes a citation of SOURCES[key]. Anything else stays text.
 */
export function Said({ text, members }: { text: string; members: Member[] }) {
  const parts = text.split(/(@[\w-]+|\[\[[\w-]+\]\])/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith("@")) {
          const m = members.find((x) => x.name.toLowerCase() === p.slice(1).toLowerCase());
          if (m) return <MentionChip key={i} m={m} />;
        }
        const cite = /^\[\[([\w-]+)\]\]$/.exec(p);
        if (cite && SOURCES[cite[1]]) return <Citation key={i} source={SOURCES[cite[1]]} />;
        return <Fragment key={i}>{p}</Fragment>;
      })}
    </>
  );
}
