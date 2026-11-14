"use client";

/** Simple version: two pages (Team, Permissions) and one subpage (a session). Pesto UI + shadcn only. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, ShieldCheck, Users } from "lucide-react";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { IconRail, IconRailItem, IconRailSpacer } from "@/components/icon-rail";
import { OrbAvatar, type OrbHue } from "@/components/orb-avatar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Orb, type AgentState } from "@/components/ui/orb";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";

export type AgentId = "clerk" | "auditor" | "scribe";

export const team: { id: AgentId; name: string; hue: OrbHue; job: string; online: boolean; now: string; sessions: number }[] = [
  { id: "clerk", name: "Clerk", hue: "blue", job: "Pays vendor invoices", online: true, now: "Reading invoice 121", sessions: 12 },
  { id: "auditor", name: "Auditor", hue: "violet", job: "Reviews every draft", online: false, now: "Last run 1 h ago", sessions: 4 },
  { id: "scribe", name: "Scribe", hue: "teal", job: "Keeps the books tidy", online: false, now: "Next run Mon 9:00", sessions: 6 },
];

export const agentById = (id: AgentId) => team.find((a) => a.id === id)!;

export type Source = "Chat" | "Voice" | "Grok Bot" | "Schedule";
export const sourceTag: Record<Source, "secondary" | "info" | "outline" | "success"> = {
  Chat: "secondary",
  Voice: "info",
  "Grok Bot": "outline",
  Schedule: "success",
};

export const sessions: { title: string; agent: AgentId; via: Source; last: string; when: string }[] = [
  { title: "Invoice 120 from Lena", agent: "clerk", via: "Chat", last: "Drafted $2.40 to Lena. It needs one cosign.", when: "2 min ago" },
  { title: "What's waiting for a cosign?", agent: "clerk", via: "Voice", last: "Two payments to Lena are waiting.", when: "18 min ago" },
  { title: "Invoice 121 (webhook)", agent: "clerk", via: "Grok Bot", last: "Couldn't find invoice 121, so nothing was drafted.", when: "1 h ago" },
  { title: "Review proposal #5", agent: "auditor", via: "Chat", last: "Matches invoice 120 and the saved payee.", when: "1 h ago" },
  { title: "Weekly vendor check", agent: "clerk", via: "Schedule", last: "Lena: risk low. Paid $0.02.", when: "Mon 9:00" },
  { title: "Month-end notes", agent: "scribe", via: "Schedule", last: "Wrote 3 notes to memory.", when: "Nov 1" },
];

export function Shell({ page, children }: { page: "team" | "permissions"; children: React.ReactNode }) {
  const router = useRouter();
  return (
    <div className="flex h-screen bg-background text-foreground">
      <div className="flex p-3">
        <IconRail srLabel="Cosign" size="sm" className="h-full">
          <IconRailItem srLabel="Team" icon={<Users />} active={page === "team"} onClick={() => router.push("/mockups/v2/team")} />
          <IconRailItem srLabel="Permissions" icon={<ShieldCheck />} active={page === "permissions"} onClick={() => router.push("/mockups/v2/permissions")} />
          <IconRailSpacer />
          <li>
            <Avatar className="size-8">
              <AvatarFallback>SY</AvatarFallback>
            </Avatar>
          </li>
        </IconRail>
      </div>
      <div className="min-w-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

/** Each hue's two strongest colours from the Pesto orb palette (no near-white stops), for the ElevenLabs voice Orb. */
export const HUE_COLORS: Record<OrbHue, [string, string]> = {
  violet: ["#864eff", "#ff6fc5"],
  pink: ["#ff65b8", "#ff7f7b"],
  orange: ["#ff8823", "#fe0011"],
  blue: ["#247dff", "#2ab5f7"],
  teal: ["#00d8c0", "#18b0ff"],
};
/**
 * What the ElevenLabs Orb draws with inside an agent orb: each hue's pair mixed with 65% white. Multiplied on the
 * Pesto disc, strong colours turn it into a dark pinwheel; pale ones leave the disc's own colour and soft shapes.
 */
const ORB_COLORS = Object.fromEntries(
  Object.entries(HUE_COLORS).map(([hue, pair]) => [hue, pair.map((hex) => towardWhite(hex, 0.65)) as [string, string]]),
) as Record<OrbHue, [string, string]>;
function towardWhite(hex: string, w: number) {
  const n = parseInt(hex.slice(1), 16);
  return `#${[n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * w).toString(16).padStart(2, "0")).join("")}`;
}
const HUE_SEED: Record<OrbHue, number> = { violet: 1000, pink: 2000, orange: 3000, blue: 4000, teal: 5000 };

/**
 * An agent's orb, the same one everywhere, from idle to talking: Pesto's OrbAvatar (the hue's filled disc) with the
 * ElevenLabs Orb flowing inside it. The Orb draws its shapes on white; multiply keeps the disc's colour wherever
 * the Orb is white, so the disc stays full of colour and only changes inside. Nothing turns. A call changes
 * `state` on the orb already on screen (ElevenLabs' voice-chat blocks do the same) instead of swapping in another.
 * Each one is a WebGL canvas and a page gets about 16, so long lists use `still`: the disc alone.
 */
export function AgentOrb({
  hue,
  state = null,
  still = false,
  className = "size-6",
}: {
  hue: OrbHue;
  state?: AgentState;
  still?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("relative isolate shrink-0 overflow-hidden rounded-full", className)}>
      <OrbAvatar hue={hue} className="absolute inset-0 size-full" />
      {!still && (
        <Orb
          colors={ORB_COLORS[hue]}
          seed={HUE_SEED[hue]}
          agentState={state}
          className="absolute inset-0 scale-110 mix-blend-multiply [html.dark_&]:mix-blend-screen"
        />
      )}
    </div>
  );
}

/** What the agent did, one line until opened (shadcn Trace). */
export function Steps({ title, steps, open = false, running = false }: { title: string; steps: string[]; open?: boolean; running?: boolean }) {
  return (
    <Trace>
      <TraceCollapsible defaultOpen={open}>
        <TraceCollapsibleTrigger>
          <TraceLine status={running ? "running" : undefined}>
            <TraceIcon>
              <CircleCheck />
            </TraceIcon>
            <TraceTitle>{title}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace className="mt-2 ml-2 border-l pl-4">
            {steps.map((s) => (
              <TraceLine key={s}>
                <TraceIcon>
                  <CircleCheck />
                </TraceIcon>
                <TraceTitle>{s}</TraceTitle>
              </TraceLine>
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

export type Decision = "open" | "approved" | "denied";

/**
 * Asks for a yes before an action runs: shadcn AI Elements' Confirmation pattern (an outline Item with Deny and
 * Approve). Used for every action that needs a person: a paid API call above the ask-first amount, a command, a
 * treasury payment (no proposal cards: Simon, 2026-11-14). Once decided it becomes one line of the agent's steps (Trace), like the shadcn example.
 */
export function ApprovalRow({
  icon,
  title,
  description,
  approved,
  denied,
  decision,
  onDecide,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  approved: string; // the step line once approved
  denied: string; // the step line once denied
  decision?: Decision; // controlled from outside; otherwise the row keeps its own
  onDecide?: (approved: boolean) => void;
}) {
  const [own, setOwn] = useState<Decision>("open");
  const d = decision ?? own;
  const decide = (yes: boolean) => {
    setOwn(yes ? "approved" : "denied");
    onDecide?.(yes);
  };
  if (d === "open") {
    return (
      <Item variant="outline" size="sm" className="max-w-md">
        <ItemMedia variant="icon">{icon}</ItemMedia>
        <ItemContent>
          <ItemTitle>{title}</ItemTitle>
          <ItemDescription>{description}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button size="sm" variant="outline" onClick={() => decide(false)}>
            Deny
          </Button>
          <Button size="sm" onClick={() => decide(true)}>
            Approve
          </Button>
        </ItemActions>
      </Item>
    );
  }
  return (
    <Trace>
      <TraceLine>
        <TraceIcon>{icon}</TraceIcon>
        <TraceTitle>{d === "approved" ? approved : denied}</TraceTitle>
      </TraceLine>
    </Trace>
  );
}
