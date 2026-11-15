"use client";

import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Field } from "@/components/field";
import { SectionFooter } from "@/components/section-footer";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { usd, type AgentSetup } from "./mock";

/** The limits a person can change on an agent, shaped after the backend's Controls. */
export type LimitKey = "apiPerPayment" | "apiPerDay" | "draftPerPayment" | "draftPerDay" | "askAbove" | "perHour" | "pcPerWeek" | "pcPerRequest" | "swapMove";
export type Limits = Record<LimitKey, number>;

/** Labels inside a section (the section's title says whose money it is). */
export const LABELS: Record<LimitKey, string> = {
  apiPerPayment: "Per payment",
  apiPerDay: "Per day",
  draftPerPayment: "Per payment",
  draftPerDay: "Per day",
  askAbove: "Ask a person above",
  perHour: "Payments an hour",
  pcPerWeek: "Refill, per week",
  pcPerRequest: "Refill, at most per draw",
  swapMove: "Swap price may move",
};
/** Labels where sections mix (the before → after list). */
const FULL: Record<LimitKey, string> = {
  apiPerPayment: "Wallet, per payment",
  apiPerDay: "Wallet, per day",
  draftPerPayment: "Treasury, per payment",
  draftPerDay: "Treasury, per day",
  askAbove: "Ask a person above",
  perHour: "Payments an hour",
  pcPerWeek: "Refill from the treasury, per week",
  pcPerRequest: "Refill, at most per draw",
  swapMove: "Swap price may move, at most",
};
/** The weekly refill lives on the treasury contract: saving it asks an approver to sign. */
const ONCHAIN: LimitKey[] = ["pcPerWeek"];
export const fmt = (k: LimitKey, v: number) => (k === "perHour" ? `${v} an hour` : k === "swapMove" ? `${v}%` : usd(v));

export const limitsOf = (a: AgentSetup): Limits => {
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
    swapMove: (c.maxSlippageBps ?? 300) / 100,
  };
};

/** Edits are a draft until Save, so each change can show as before → after. */
export function useDraft(start: Limits) {
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
export type Draft = ReturnType<typeof useDraft>;

/** Pesto Input Group: "$" before money, "an hour" after the speed limit. */
function LimitInput({ d, k }: { d: Draft; k: LimitKey }) {
  return (
    <InputGroup>
      {k !== "perHour" && k !== "swapMove" && (
        <InputGroupAddon>
          <InputGroupText>$</InputGroupText>
        </InputGroupAddon>
      )}
      <InputGroupInput key={`${k}-${d.version}`} id={`limit-${k}`} defaultValue={d.draft[k]} inputMode="decimal" onChange={(e) => d.set(k, e.target.value)} />
      {(k === "perHour" || k === "swapMove") && (
        <InputGroupAddon align="inline-end">
          <InputGroupText>{k === "perHour" ? "an hour" : "%"}</InputGroupText>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

/** Saves on the server (the app); resolves once saved, throws with the server's reason if it refused. */
export type SaveLimits = (next: Limits, changes: { key: LimitKey; before: number; after: number }[]) => Promise<void>;

/** Pesto Section Footer: the pending changes, one per line as before → after, then Cancel and Save. */
function ChangesFooter({ d, keys, onDone, onSave, onError }: { d: Draft; keys: LimitKey[]; onDone: () => void; onSave?: SaveLimits; onError: (e: string | null) => void }) {
  const [saving, setSaving] = useState(false);
  const changes = d.changes.filter((x) => keys.includes(x.key));
  const n = changes.length;
  const onchain = changes.some((x) => ONCHAIN.includes(x.key));
  return (
    <SectionFooter
      align="between"
      className="sm:flex-col sm:items-stretch"
      helper={
        n === 0 ? (
          "No changes."
        ) : (
          <>
            {changes.map((x) => (
              <span key={x.key} className="block">
                {FULL[x.key]}: <span className="line-through">{fmt(x.key, x.before)}</span> → <span className="font-medium text-foreground">{fmt(x.key, x.after)}</span>
              </span>
            ))}
            {onchain && <span className="block">The weekly refill is on the treasury contract: an approver signs the change.</span>}
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
        disabled={n === 0 || saving}
        onClick={async () => {
          if (onSave) {
            onError(null);
            setSaving(true);
            try {
              await onSave(d.draft, changes);
            } catch (e) {
              onError((e as Error).message);
              return;
            } finally {
              setSaving(false);
            }
          }
          d.save();
          onDone();
        }}
      >
        {saving ? "Saving…" : n > 1 ? `Save ${n} changes` : n === 1 ? "Save change" : "Save"}
      </Button>
    </SectionFooter>
  );
}

/**
 * One section's limits in a side Sheet (Pesto Sheet + Field + Input Group). A change is a draft, shown as
 * before → after, until Save; closing without Save drops it.
 */
export function LimitsSheet({ d, keys, title, open, onOpenChange, onSave }: { d: Draft; keys: LimitKey[]; title: string; open: boolean; onOpenChange: (o: boolean) => void; onSave?: SaveLimits }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          d.cancel();
          setError(null);
        }
        onOpenChange(o);
      }}
    >
      <SheetContent side="right" className="flex flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>Checked by our server before anything is signed.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-3 overflow-auto px-4 pb-4">
          {keys.map((k) => (
            <Field key={k} label={FULL[k]} htmlFor={`limit-${k}`} hint={d.draft[k] !== d.saved[k] ? `Was ${fmt(k, d.saved[k])}` : ONCHAIN.includes(k) ? "On the treasury contract: an approver signs a change." : undefined}>
              <LimitInput d={d} k={k} />
            </Field>
          ))}
        </div>
        <div className="flex flex-col gap-3 px-4 pb-4">
          {error && (
            <Alert variant="destructive" severityLabel="Not saved">
              <AlertTitle>The server said no</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <ChangesFooter d={d} keys={keys} onDone={() => onOpenChange(false)} onSave={onSave} onError={setError} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
