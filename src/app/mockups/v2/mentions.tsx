"use client";

import { Fragment } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tag } from "@/components/ui/tag";
import type { OrbHue } from "@/components/orb-avatar";
import { cn } from "@/lib/utils";
import type { Agent } from "./agents";
import { AddressLine, LENA, personAddress, walletOf } from "./money";
import { AgentOrb } from "./parts";
import type { Room, Teammate } from "./store";

/** Someone you can @: an agent or a teammate. */
/** `address` is the person's wallet, or the agent's own wallet. */
/** `image` = a connected product's own icon (Grok Bot); `badge` replaces "Agent" in the @ list and the card. */
export type Member = { id: string; name: string; kind: "agent" | "person"; sub: string; address: string; hue?: OrbHue; initials?: string; image?: string; badge?: string };

export const agentMember = (a: Agent): Member => ({ id: a.id, name: a.name, kind: "agent", sub: a.job, address: a.wallet ?? walletOf(a.id).address, hue: a.hue });
export const personMember = (t: Teammate): Member => ({ id: t.id, name: t.name, kind: "person", sub: t.role, address: t.address ?? personAddress(t.id), initials: t.initials });

/**
 * Grok Bot, the team's background helper: it runs schedules, watches the chain and checks the work, and hands
 * problems back with an @mention. It has no wallet (it works through Cosign's tools), and its face is its own app icon.
 */
export const GROK_BOT: Member = {
  id: "grokbot",
  name: "Grok Bot",
  kind: "agent",
  sub: "Works in the background: schedules, onchain checks, follow-ups",
  address: "",
  image: "/brand/grok-bot.png",
  badge: "Background",
};

/** Everyone in a room you could @ (not yourself): agents first, then Grok Bot, then people. */
export function roomMembers(room: Room, team: Teammate[], agents: Agent[]): Member[] {
  return [
    ...agents.filter((a) => room.members.includes(a.id)).map(agentMember),
    GROK_BOT,
    ...team.filter((t) => room.members.includes(t.id) && !t.you).map(personMember),
  ];
}

/** Who is @named in a piece of text. */
export const mentionedIn = (text: string, members: Member[]) =>
  members.filter((m) => new RegExp(`(^|\\s)@${m.name}(?![\\w-])`, "i").test(text));

/** A member's face: its own image (Grok Bot's app icon), the agent's orb, or the teammate's initials. */
export function MemberFace({ m, className = "size-6" }: { m: Member; className?: string }) {
  if (m.image) return <BrandFace src={m.image} name={m.name} className={className} />;
  return m.kind === "agent" ? (
    <AgentOrb hue={m.hue ?? "blue"} still className={className} />
  ) : (
    /* default size, so `className` sets it (the sm size's data selector would win over it) */
    <Avatar className={className}>
      <AvatarFallback className="text-[0.55rem]">{m.initials}</AvatarFallback>
    </Avatar>
  );
}

/** A connected product's own icon (e.g. the Grok Bot app icon, from its app bundle), in its rounded square. */
export function BrandFace({ src, name, className = "size-6" }: { src: string; name: string; className?: string }) {
  return (
    <Avatar className={cn("rounded-[22%] after:rounded-[22%]", className)}>
      <AvatarImage src={src} alt={name} className="rounded-[22%]" />
      <AvatarFallback className="rounded-[22%] text-[0.55rem]">{name.slice(0, 2)}</AvatarFallback>
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
            {m.kind === "agent" && <Tag variant="info">{m.badge ?? "Agent"}</Tag>}
          </div>
          <p className="truncate text-xs text-muted-foreground">{m.sub}</p>
          {m.address ? (
            <AddressLine address={m.address} label={`${m.name}'s wallet address`} className="-ml-0.5" />
          ) : (
            <p className="text-xs text-muted-foreground">No wallet · never holds a key</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Where an agent got something: a file, a saved record or a page. */
/** `address` is shown copyable and linked to the explorer under the description. */
export type Source = { label: string; title: string; description: string; url?: string; address?: { value: string; label: string } };

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
        {source.address && <AddressLine address={source.address.value} label={source.address.label} className="-ml-0.5" />}
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
    description: "Added by Simon on Nov 12.",
    address: { value: LENA.address, label: "Lena's address" },
  },
  proposal: {
    label: "explorer.testnet.arc.io",
    title: "Proposal #5 on Arc",
    description: "Treasury proposal: $2.40 USDC to Lena, 0 of 1 approvals.",
    address: { value: LENA.address, label: "Lena's address" },
    url: "https://explorer.testnet.arc.io/address/0xb496FD2D5b29A5b12Ee3d30e7359578fec86e62c",
  },
};

/**
 * A message's text with its @mentions and [[source]] citations drawn inline. "@Name" becomes a mention when Name is
 * someone in `members`; "[[key]]" becomes a citation of SOURCES[key]. Anything else stays text.
 */
/* member names may have spaces ("Grok Bot"): match the longest names first, then any @word */
const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function splitter(members: Member[]) {
  const names = members.map((m) => m.name).sort((a, b) => b.length - a.length).map(escape);
  const named = names.length ? `@(?:${names.join("|")})(?![\\w])|` : "";
  return new RegExp(`(${named}@[\\w-]+|\\[\\[[\\w-]+\\]\\])`, "gi");
}

export function Said({ text, members }: { text: string; members: Member[] }) {
  const parts = text.split(splitter(members));
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
