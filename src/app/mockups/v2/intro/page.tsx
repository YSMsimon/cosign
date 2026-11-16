"use client";

/* The figure spoken over at the start of the demo video (0:00–0:25). Built only from
   existing parts: the live agent orb, shadcn Card / Item / Avatar, StatusBadge and
   lucide icons, arranged with CSS. Click, Space or → shows the second row on the line
   "So I built Cosign." */

import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, Check, KeyRound, Send, UserRound } from "lucide-react";
import { Avatar, AvatarFallback, AvatarGroup } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { StatusBadge } from "@/components/ui/status-badge";
import { AgentOrb } from "../parts";

function Person({ icon = <UserRound /> }: { icon?: ReactNode }) {
  return (
    <Avatar size="lg">
      <AvatarFallback className="[&_svg]:size-5">{icon}</AvatarFallback>
    </Avatar>
  );
}

function Team() {
  return (
    <AvatarGroup>
      <Person />
      <Person />
      <Person />
    </AvatarGroup>
  );
}

function Steps({ items }: { items: string[] }) {
  return (
    <ul className="mt-1.5 space-y-1">
      {items.map((t) => (
        <li key={t} className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Check className="size-3.5 shrink-0" /> {t}
        </li>
      ))}
    </ul>
  );
}

function Node({ media, title, children }: { media: ReactNode; title: string; children?: ReactNode }) {
  return (
    <Item variant="outline" className="h-full flex-col items-start gap-3 bg-card">
      <ItemMedia>{media}</ItemMedia>
      <ItemContent>
        <ItemTitle className="text-base">{title}</ItemTitle>
        {children}
      </ItemContent>
    </Item>
  );
}

function Arrow({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 text-muted-foreground">
      <ArrowRight className="size-5" />
      {label && <span className="text-xs whitespace-nowrap">{label}</span>}
    </div>
  );
}

function Row({ tag, children, dim = false }: { tag: ReactNode; children: ReactNode; dim?: boolean }) {
  return (
    <Card className={`gap-4 p-6 transition-opacity duration-500 ${dim ? "opacity-0" : "opacity-100"}`}>
      <div>{tag}</div>
      <div className="grid grid-cols-[minmax(0,1fr)_6rem_minmax(0,1.2fr)_6rem_minmax(0,1fr)] items-stretch gap-3">{children}</div>
    </Card>
  );
}

export default function IntroFigure() {
  const [step, setStep] = useState(1);

  useEffect(() => {
    const next = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "ArrowRight") setStep(2);
      if (e.key === "ArrowLeft") setStep(1);
    };
    window.addEventListener("keydown", next);
    return () => window.removeEventListener("keydown", next);
  }, []);

  return (
    <main
      onClick={() => setStep((s) => (s === 1 ? 2 : 1))}
      className="flex min-h-screen items-center justify-center bg-background px-12 py-10 text-foreground"
    >
      <div className="w-full max-w-5xl space-y-5">
        <Row tag={<Badge variant="secondary">A team that pays in crypto, today</Badge>}>
          <Node media={<Team />} title="Teammates">
            <p className="mt-1.5 text-sm text-muted-foreground">need a vendor paid</p>
          </Node>
          <Arrow label="ask and wait" />
          <Node media={<Person icon={<KeyRound />} />} title="The few who can sign">
            <Steps items={["Read the invoice", "Check the amount", "Check the address", "Draft the payment", "Sign it"]} />
          </Node>
          <Arrow />
          <Node media={<Send className="size-5 text-muted-foreground" />} title="Paid onchain">
            <StatusBadge status="busy" className="mt-2">One mistake can&apos;t be undone</StatusBadge>
          </Node>
        </Row>

        <Row dim={step < 2} tag={<Badge>With Cosign</Badge>}>
          <Node media={<Team />} title="Anyone on the team">
            <p className="mt-1.5 text-sm text-muted-foreground">asks a shared agent</p>
          </Node>
          <Arrow label="asks" />
          <Node media={<AgentOrb hue="blue" className="size-10" />} title="The agent">
            <Steps items={["Checks the amount and address", "Pays for each check itself", "Drafts the payment"]} />
          </Node>
          <Arrow label="already checked" />
          <Node media={<Person icon={<KeyRound />} />} title="Someone who can sign">
            <StatusBadge status="success" className="mt-2">Just reviews and signs</StatusBadge>
          </Node>
        </Row>
      </div>
    </main>
  );
}
