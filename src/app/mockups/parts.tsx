"use client";

/** Shared pieces for the three main-board mockups. Every element is a shadcn component or a lucide icon. */
import { ArrowUp, AudioLines, Bot, CircleCheck, Mic, Paperclip, ShieldCheck } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";

export const agents = [
  { id: "clerk", name: "Clerk", job: "Accounts payable", status: "working", note: "Reading invoice 121", grokBot: true },
  { id: "auditor", name: "Auditor", job: "Read-only reviews", status: "idle", note: "Idle", grokBot: false },
] as const;

export const people = [
  { name: "Simon", role: "CFO · you", initials: "SY" },
  { name: "Priya", role: "Approver", initials: "PR" },
  { name: "Jordan", role: "Viewer", initials: "JO" },
];

export const rooms = [
  { name: "general", unread: 0 },
  { name: "approvals", unread: 2 },
  { name: "invoices", unread: 0 },
  { name: "treasury", unread: 0 },
];

export function StatusDot({ status }: { status: string }) {
  const color = status === "working" ? "bg-emerald-500" : status === "failed" ? "bg-red-500" : "bg-muted-foreground/40";
  return <span className={`inline-block size-2 shrink-0 rounded-full ${color}`} />;
}

export function AgentAvatar({ className = "size-8" }: { className?: string }) {
  return (
    <Avatar className={className}>
      <AvatarFallback className="bg-primary text-primary-foreground">
        <Bot className="size-4" />
      </AvatarFallback>
    </Avatar>
  );
}

export function PersonAvatar({ initials, className = "size-8" }: { initials: string; className?: string }) {
  return (
    <Avatar className={className}>
      <AvatarFallback>{initials}</AvatarFallback>
    </Avatar>
  );
}

/** What the agent did, folded like shadcn's Subagent pattern (Trace + collapsible). */
export function AgentRun({ title, steps }: { title: string; steps: { text: string; status?: "running" | "pending" }[] }) {
  return (
    <Trace>
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <CircleCheck />
            </TraceIcon>
            <TraceTitle>{title}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace className="mt-2 ml-2 border-l pl-4">
            {steps.map((s) => (
              <TraceLine key={s.text} status={s.status}>
                <TraceIcon>
                  <CircleCheck />
                </TraceIcon>
                <TraceTitle>{s.text}</TraceTitle>
              </TraceLine>
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

/** A treasury payment drafted by an agent, waiting for a human cosign from their own wallet. */
export function CosignCard({ id = 5, compact = false }: { id?: number; compact?: boolean }) {
  return (
    <Card className={compact ? "gap-3 py-4" : "w-full max-w-md"}>
      <CardHeader className={compact ? "px-4" : undefined}>
        <CardDescription>Payment proposal #{id} · drafted by Clerk</CardDescription>
        <CardTitle className="text-2xl tabular-nums">$2.40 USDC</CardTitle>
        <CardAction>
          <Badge variant="outline">0 of 1 cosigns</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className={`grid gap-1.5 text-sm ${compact ? "px-4" : ""}`}>
        <div className="flex justify-between">
          <span className="text-muted-foreground">To</span>
          <span>Lena (contractor) · 0x7797…f1e7</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">For</span>
          <span>Invoice 120 · frontend work</span>
        </div>
        <div className="flex items-center gap-1.5 pt-1 text-emerald-600">
          <ShieldCheck className="size-4" />
          <span>Saved payee · under the $5 limit · name and address match</span>
        </div>
      </CardContent>
      <CardFooter className={`gap-2 ${compact ? "px-4" : ""}`}>
        <Button size="sm">Cosign with wallet</Button>
        <Button size="sm" variant="outline">
          Reject
        </Button>
      </CardFooter>
    </Card>
  );
}

export function Composer({ placeholder, grok = false }: { placeholder: string; grok?: boolean }) {
  return (
    <InputGroup className={grok ? "rounded-3xl" : undefined}>
      <InputGroupTextarea placeholder={placeholder} rows={grok ? 1 : 2} className="min-h-0" />
      <InputGroupAddon align="block-end">
        <InputGroupButton size="icon-sm" variant="ghost" aria-label="Attach">
          <Paperclip />
        </InputGroupButton>
        {grok && (
          <Badge variant="secondary" className="ml-1">
            Grok 4.3
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          <InputGroupButton size="icon-sm" variant="ghost" aria-label="Dictate">
            <Mic />
          </InputGroupButton>
          {grok ? (
            <InputGroupButton size="sm" variant="default" className="rounded-full">
              <AudioLines /> Talk
            </InputGroupButton>
          ) : (
            <InputGroupButton size="icon-sm" variant="default" aria-label="Send">
              <ArrowUp />
            </InputGroupButton>
          )}
        </div>
      </InputGroupAddon>
    </InputGroup>
  );
}

export function LimitMeter({ label, used, limit }: { label: string; used: number; limit: number }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          ${used.toFixed(2)} of ${limit.toFixed(2)}
        </span>
      </div>
      <Progress value={(used / limit) * 100} />
    </div>
  );
}

export function WalletSummary() {
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border p-3">
          <div className="text-xs text-muted-foreground">Wallet</div>
          <div className="text-lg font-semibold tabular-nums">$4.41</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-xs text-muted-foreground">Nanopayments</div>
          <div className="text-lg font-semibold tabular-nums">$0.41</div>
        </div>
      </div>
      <LimitMeter label="Drafts today" used={2.4} limit={20} />
      <LimitMeter label="API purchases today" used={0.03} limit={0.5} />
      <LimitMeter label="Petty cash this week" used={1} limit={1} />
      <Separator />
    </div>
  );
}
