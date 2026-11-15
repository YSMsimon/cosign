"use client";

import { useState } from "react";
import { Coins, Hand, Landmark, Pencil, PiggyBank, Timer } from "lucide-react";
import { DescriptionList } from "@/components/description-list";
import { Field } from "@/components/field";
import { PanelCard, PanelCardAction, PanelCardContent, PanelCardDescription, PanelCardHeader, PanelCardHeading, PanelCardIcon, PanelCardTitle } from "@/components/panel-card";
import { QuotaTile } from "@/components/quota-tile";
import { SectionFooter } from "@/components/section-footer";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { usd, type AgentSetup } from "./mock";

/** The limits a person can change on an agent, shaped after the backend's Controls. */
type LimitKey = "apiPerPayment" | "apiPerDay" | "draftPerPayment" | "draftPerDay" | "askAbove" | "perHour" | "pcPerWeek" | "pcPerRequest";
type Limits = Record<LimitKey, number>;

const LABELS: Record<LimitKey, string> = {
  apiPerPayment: "API purchase, per payment",
  apiPerDay: "API purchases, per day",
  draftPerPayment: "Treasury draft, per payment",
  draftPerDay: "Treasury drafts, per day",
  askAbove: "Ask a person above",
  perHour: "Payments an hour",
  pcPerWeek: "Petty cash, per week",
  pcPerRequest: "Petty cash, per request",
};
/** Petty cash per week lives on the treasury contract: saving it asks an approver to sign. */
const ONCHAIN: LimitKey[] = ["pcPerWeek"];
const fmt = (k: LimitKey, v: number) => (k === "perHour" ? `${v} an hour` : usd(v));

const limitsOf = (a: AgentSetup): Limits => {
  const c = a.controls;
  return {
    apiPerPayment: c.purchases.perPayment ?? 0,
    apiPerDay: c.purchases.daily ?? 0,
    draftPerPayment: c.drafts.perPayment ?? 0,
    draftPerDay: c.drafts.daily ?? 0,
    askAbove: c.askAboveUsd ?? 0,
    perHour: c.maxPaymentsPerHour ?? 0,
    pcPerWeek: c.pettyCashPerWeekUsd ?? 0,
    pcPerRequest: c.topUpMaxUsd ?? 0,
  };
};

/** The sheet's groups: only the limits for abilities that are on. */
function groupsFor(a: AgentSetup) {
  const ab = a.abilities;
  return [
    { title: "Spending limits", keys: [...(ab.buy ? (["apiPerPayment", "apiPerDay"] as const) : []), ...(ab.draft ? (["draftPerPayment", "draftPerDay"] as const) : [])] as LimitKey[] },
    { title: "Ask a person, and speed", keys: [...(ab.buy ? (["askAbove"] as const) : []), "perHour"] as LimitKey[] },
    { title: "Petty cash", keys: (ab.pettyCash ? ["pcPerWeek", "pcPerRequest"] : []) as LimitKey[] },
  ].filter((g) => g.keys.length > 0);
}

/** Edits are a draft until Save, so each change can show as before → after. */
function useDraft(start: Limits) {
  const [saved, setSaved] = useState(start);
  const [draft, setDraft] = useState(start);
  const [version, setVersion] = useState(0); // remounts the uncontrolled inputs after Save or Cancel
  const changes = (Object.keys(start) as LimitKey[]).filter((k) => draft[k] !== saved[k]).map((k) => ({ key: k, before: saved[k], after: draft[k] }));
  return {
    saved,
    draft,
    changes,
    version,
    set: (k: LimitKey, raw: string) => {
      const n = Number(raw);
      if (raw.trim() !== "" && Number.isFinite(n) && n >= 0) setDraft((d) => ({ ...d, [k]: n }));
    },
    save: () => {
      setSaved(draft);
      setVersion((v) => v + 1);
    },
    cancel: () => {
      setDraft(saved);
      setVersion((v) => v + 1);
    },
  };
}
type Draft = ReturnType<typeof useDraft>;

/** Pesto Input Group: "$" before money, "an hour" after the speed limit. */
function LimitInput({ d, k }: { d: Draft; k: LimitKey }) {
  return (
    <InputGroup>
      {k !== "perHour" && (
        <InputGroupAddon>
          <InputGroupText>$</InputGroupText>
        </InputGroupAddon>
      )}
      <InputGroupInput key={`${k}-${d.version}`} id={`limit-${k}`} defaultValue={d.draft[k]} inputMode="decimal" onChange={(e) => d.set(k, e.target.value)} />
      {k === "perHour" && (
        <InputGroupAddon align="inline-end">
          <InputGroupText>an hour</InputGroupText>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

/** Pesto Section Footer: the pending changes, one per line as before → after, then Cancel and Save. */
function ChangesFooter({ d, onDone }: { d: Draft; onDone: () => void }) {
  const n = d.changes.length;
  const onchain = d.changes.some((x) => ONCHAIN.includes(x.key));
  return (
    <SectionFooter
      align="between"
      className="sm:flex-col sm:items-stretch"
      helper={
        n === 0 ? (
          "No changes."
        ) : (
          <>
            {d.changes.map((x) => (
              <span key={x.key} className="block">
                {LABELS[x.key]}: <span className="line-through">{fmt(x.key, x.before)}</span> → <span className="font-medium text-foreground">{fmt(x.key, x.after)}</span>
              </span>
            ))}
            {onchain && <span className="block">Petty cash per week is on the treasury contract: an approver signs the change.</span>}
          </>
        )
      }
    >
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          d.cancel();
          onDone();
        }}
      >
        Cancel
      </Button>
      <Button
        size="sm"
        disabled={n === 0}
        onClick={() => {
          d.save();
          onDone();
        }}
      >
        {n > 1 ? `Save ${n} changes` : n === 1 ? "Save change" : "Save"}
      </Button>
    </SectionFooter>
  );
}

/* 2 across when the page is narrow, all in one row once it is wide enough (container query) */
const COLS = ["grid-cols-2", "grid-cols-2", "grid-cols-2", "grid-cols-2 @3xl:grid-cols-3", "grid-cols-2 @5xl:grid-cols-4"];

/**
 * The agent's limits, values first (Simon picked option A, 2026-11-14): Pesto Quota Tiles for every limit with a running
 * total (used against the limit), a Description List for the rest, and one Sheet where all of them change. A change is a
 * draft, shown as before → after, until Save. Remount per agent (key) so each agent keeps its own draft.
 */
export function LimitsView({ a }: { a: AgentSetup }) {
  const d = useDraft(limitsOf(a));
  const [open, setOpen] = useState(false);
  const s = d.saved;
  const ab = a.abilities;
  const pcUsed = a.onchain.pettyCashPerWeekUsd - a.onchain.pettyCashLeftUsd;
  /* the figure one step down (36 → 30 px) so "$0.03 / $0.50" fits four across; set from here, the library is untouched */
  const fit = "[&_[data-slot=stat]]:text-3xl";
  const tile = { formatValue: usd, healthyLabel: "Under", criticalLabel: "Near limit", className: fit };
  const tiles = [
    ab.buy && <QuotaTile key="api" icon={Coins} label="APIs today" used={a.usage.purchasesToday} limit={s.apiPerDay} srLabel="API purchases today" {...tile} />,
    ab.draft && <QuotaTile key="drafts" icon={Landmark} label="Drafts today" used={a.usage.draftsToday} limit={s.draftPerDay} srLabel="Treasury drafts today" {...tile} />,
    <QuotaTile key="hour" icon={Timer} label="This hour" used={a.usage.paymentsThisHour} limit={s.perHour} srLabel="Payments this hour" healthyLabel="Under" criticalLabel="Near limit" className={fit} />,
    ab.pettyCash && <QuotaTile key="pc" icon={PiggyBank} label="Petty cash" used={pcUsed} limit={s.pcPerWeek} srLabel="Petty cash this week" {...tile} />,
  ].filter(Boolean);
  const rows = [ab.buy && "apiPerPayment", ab.draft && "draftPerPayment", ab.buy && "askAbove", ab.pettyCash && "pcPerRequest"].filter(Boolean) as LimitKey[];

  return (
    <div className="col-span-2 flex flex-col gap-4">
      <div className="@container">
        <div className={`grid gap-4 ${COLS[tiles.length]}`}>{tiles}</div>
      </div>
      <PanelCard>
        <PanelCardHeader>
          <PanelCardIcon tone="info">
            <Hand />
          </PanelCardIcon>
          <PanelCardHeading>
            <PanelCardTitle>Per payment, and when to ask</PanelCardTitle>
            <PanelCardDescription>Anything bigger is refused; above the line, a member OKs it in the chat.</PanelCardDescription>
          </PanelCardHeading>
          <PanelCardAction>
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              <Pencil /> Change limits
            </Button>
          </PanelCardAction>
        </PanelCardHeader>
        {rows.length > 0 && (
          <PanelCardContent>
            <DescriptionList layout="divided" items={rows.map((k) => ({ id: k, term: LABELS[k], details: fmt(k, s[k]) }))} />
          </PanelCardContent>
        )}
      </PanelCard>

      <Sheet
        open={open}
        onOpenChange={(o) => {
          if (!o) d.cancel(); // closing without Save drops the draft
          setOpen(o);
        }}
      >
        <SheetContent side="right" className="flex flex-col gap-0 sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{a.name}&apos;s limits</SheetTitle>
            <SheetDescription>Checked by our server before anything is signed.</SheetDescription>
          </SheetHeader>
          <div className="flex flex-1 flex-col gap-6 overflow-auto px-4 pb-4">
            {groupsFor(a).map((g) => (
              <div key={g.title} className="flex flex-col gap-3">
                <span className="text-sm font-medium">{g.title}</span>
                {g.keys.map((k) => (
                  <Field key={k} label={LABELS[k]} htmlFor={`limit-${k}`} hint={d.draft[k] !== s[k] ? `Was ${fmt(k, s[k])}` : ONCHAIN.includes(k) ? "On the treasury contract: an approver signs a change." : undefined}>
                    <LimitInput d={d} k={k} />
                  </Field>
                ))}
              </div>
            ))}
          </div>
          <div className="px-4 pb-4">
            <ChangesFooter d={d} onDone={() => setOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
