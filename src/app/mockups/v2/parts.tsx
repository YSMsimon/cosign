"use client";

/** Simple version: two pages (Team, Permissions) and one subpage (a session). Pesto UI + shadcn only. */
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CircleCheck, ExternalLink, MessagesSquare, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { IconRail, IconRailItem, IconRailSpacer } from "@/components/icon-rail";
import { OrbAvatar, type OrbHue } from "@/components/orb-avatar";
import { Spinner } from "@/components/ui/spinner";
import { Orb, type AgentState } from "@/components/ui/orb";
import { cn } from "@/lib/utils";
import { AccountMenu } from "./account-menu";
import { AddressLine } from "./money";
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
  { title: "Invoice 120 from Lena", agent: "clerk", via: "Chat", last: "Drafted $2.40 to Lena. It needs one approval.", when: "2 min ago" },
  { title: "What's waiting for approval?", agent: "clerk", via: "Voice", last: "Two payments to Lena are waiting.", when: "18 min ago" },
  { title: "Invoice 121 (webhook)", agent: "clerk", via: "Grok Bot", last: "Couldn't find invoice 121, so nothing was drafted.", when: "1 h ago" },
  { title: "Review proposal #5", agent: "auditor", via: "Chat", last: "Matches invoice 120 and the saved payee.", when: "1 h ago" },
  { title: "Weekly vendor check", agent: "clerk", via: "Schedule", last: "Lena: risk low. Paid $0.02.", when: "Mon 9:00" },
  { title: "Month-end notes", agent: "scribe", via: "Schedule", last: "Wrote 3 notes to memory.", when: "Nov 1" },
];

/**
 * The app frame: Pesto Icon Rail with two places (rooms and agents, permissions). The Team page was dropped (Simon, 2026-11-14).
 * On the design boards (/mockups/v2) it links to the boards; in the app (/chat, /permissions) to the real pages, with
 * the signed-in account passed as `account`.
 */
export function Shell({ page, children, account }: { page: "chat" | "permissions"; children: React.ReactNode; account?: React.ReactNode }) {
  const router = useRouter();
  const board = usePathname().startsWith("/mockups");
  return (
    <div className="flex h-screen bg-background text-foreground">
      <div className="flex p-3">
        <IconRail srLabel="Cosign" size="sm" className="h-full">
          <IconRailItem srLabel="Rooms and agents" icon={<MessagesSquare />} active={page === "chat"} onClick={() => router.push(board ? "/mockups/v2/session" : "/chat")} />
          <IconRailItem srLabel="Permissions" icon={<ShieldCheck />} active={page === "permissions"} onClick={() => router.push(board ? "/mockups/v2/permissions" : "/permissions")} />
          <IconRailSpacer />
          <li>{account ?? <AccountMenu />}</li>
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
            {steps.map((s, i) => (
              <TraceLine key={`${i}-${s}`}>
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
type Outcome = { title: string; note?: string; href?: string };

/**
 * Asks for a yes before an action runs, as a Pesto Alert (Simon picked option B, 2026-11-14). Used for every action
 * that needs a person: a paid API call above the ask-a-person line, a command, a treasury payment. The disc carries
 * the state: amber while it waits, green once paid, plain once denied. After Approve, `pending` steps (connecting the
 * wallet, waiting for the signature, sending to the treasury) show one by one beside a Pesto Spinner.
 */
export function ApprovalRow({
  title,
  description,
  address,
  approved,
  denied,
  decision,
  onDecide,
  pending = [],
}: {
  title: string;
  description: string;
  /** shown under the description, copyable and linked to the explorer */
  address?: { value: string; label: string };
  approved: Outcome;
  denied: Outcome;
  decision?: Decision; // controlled from outside; otherwise the row keeps its own
  onDecide?: (approved: boolean) => void;
  /** what happens after Approve, in order (prototype: about a second each) */
  pending?: string[];
}) {
  const [own, setOwn] = useState<Decision>("open");
  const [step, setStep] = useState<number | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const d = decision ?? own;
  const decide = (yes: boolean) => {
    if (yes && pending.length) {
      setStep(0);
      pending.forEach((_, i) => i > 0 && timers.current.push(setTimeout(() => setStep(i), i * 1300)));
      timers.current.push(
        setTimeout(() => {
          setStep(null);
          setOwn("approved");
          onDecide?.(true);
        }, pending.length * 1300),
      );
      return;
    }
    setOwn(yes ? "approved" : "denied");
    onDecide?.(yes);
  };

  if (d !== "open") {
    const o = d === "approved" ? approved : denied;
    return (
      <Alert
        variant={d === "approved" ? "success" : "default"}
        action={
          o.href && (
            <Button size="icon" variant="ghost" className="size-7" aria-label="On the explorer" asChild>
              <a href={o.href} target="_blank" rel="noreferrer">
                <ExternalLink />
              </a>
            </Button>
          )
        }
      >
        <AlertTitle>{o.title}</AlertTitle>
        {o.note && <AlertDescription>{o.note}</AlertDescription>}
      </Alert>
    );
  }
  const running = step !== null;
  return (
    <Alert
      variant="warning"
      severityLabel="Needs your approval"
      action={
        running ? (
          <Spinner size="sm" label={pending[step]} className="mx-3 text-muted-foreground" />
        ) : (
          <span className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => decide(false)}>
              Deny
            </Button>
            <Button size="sm" onClick={() => decide(true)}>
              Approve
            </Button>
          </span>
        )
      }
    >
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription aria-live="polite">
        {running ? (
          pending[step]
        ) : (
          <>
            <span className="block">{description}</span>
            {address && <AddressLine address={address.value} label={address.label} />}
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** A payment the agent's rules refused: a Pesto Alert in the destructive tone. Nothing was signed. */
export function Refusal({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Alert variant="destructive" severityLabel="Refused">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
