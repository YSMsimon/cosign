"use client";

import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ArrowLeftRight, Coins, Gauge, Landmark, Pencil, RefreshCw, Sparkles, Store, UserPlus, Wallet } from "lucide-react";
import { DescriptionList } from "@/components/description-list";
import { PanelCard, PanelCardContent, PanelCardDescription, PanelCardHeader, PanelCardHeading, PanelCardIcon, PanelCardTitle } from "@/components/panel-card";
import { QuotaTile } from "@/components/quota-tile";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { Tag } from "@/components/ui/tag";
import { AddressLine } from "../money";
import { fmt, LABELS, limitsOf, LimitsSheet, useDraft, type LimitKey, type SaveLimits } from "./limits";
import { usd, type AbilityKey, type AgentSetup } from "./mock";

type Section = "wallet" | "treasury";
const KEYS: Record<Section | "speed", LimitKey[]> = {
  wallet: ["apiPerPayment", "apiPerDay", "askAbove", "swapMove", "pcPerWeek", "pcPerRequest"],
  treasury: ["draftPerPayment", "draftPerDay"],
  speed: ["perHour"],
};

/**
 * What the agent can do, sorted by whose money it is (Simon picked the Accordion fix, 2026-11-15): one Pesto Accordion
 * section per kind of money, its switch on the right. Turning a switch on opens that section's settings right under
 * it (Pesto's spring on open, a short tween on close), so the switch you clicked never moves and nothing above it
 * jumps. Inside: usage against its limit (Quota Tile), the limits (Description List), who it can pay, and one Sheet
 * where they change (before → after until Save). "Petty cash" is now "Refill from the treasury", inside the wallet.
 */
/** The lists a person can change here, each saved as a whole (the server checks it). */
export type ListKey = "allowedSellers" | "allowedPayees" | "allowedSwapTokens";

/**
 * In the app every change is saved on the server, and its refusal (e.g. loosening without All access) shows here.
 * `addable` lists what Add can offer: swap tokens and saved contacts not yet allowed; sellers are typed in.
 */
export function AgentSettings({
  a,
  onAbility,
  onSaveLimits,
  onList,
  addable,
}: {
  a: AgentSetup;
  onAbility: (key: AbilityKey, on: boolean) => void | Promise<unknown>;
  onSaveLimits?: SaveLimits;
  onList?: (list: ListKey, next: string[]) => Promise<unknown>;
  addable?: { tokens: string[]; payees: { name: string; address: string }[] };
}) {
  const [error, setError] = useState<string | null>(null);
  const save = async (p: void | Promise<unknown>) => {
    setError(null);
    try {
      await p;
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const list = (k: ListKey, next: string[]) => onList && save(onList(k, next));
  const tokens = a.controls.allowedSwapTokens ?? [];
  const sellers = a.controls.allowedSellers;
  const payees = a.controls.allowedPayees.map((p) => p.address);
  const d = useDraft(limitsOf(a));
  const s = d.saved;
  const ab = a.abilities;
  const [sheet, setSheet] = useState<Section | "speed" | null>(null);
  const [folded, setFolded] = useState<Section[]>([]); // an open section can still be folded by hand
  const on = (["wallet", "treasury"] as Section[]).filter((x) => (x === "wallet" ? ab.buy : ab.draft));
  const open = on.filter((x) => !folded.includes(x));
  const turn = (section: Section, key: AbilityKey, v: boolean) => {
    void save(onAbility(key, v));
    if (v) setFolded((f) => f.filter((x) => x !== section)); // switching on always opens it
  };

  /* the figure one step down so the tile fits beside the limits; set from here, the library is untouched */
  const tile = { formatValue: usd, healthyLabel: "Under", criticalLabel: "Near limit", className: "[&_[data-slot=stat]]:text-3xl" };
  const rows = (keys: LimitKey[]) => keys.map((k) => ({ id: k, term: LABELS[k], details: fmt(k, s[k]) }));
  const refillLeft = Math.max(0, Math.min(a.onchain.pettyCashLeftUsd, s.pcPerWeek));

  return (
    <PanelCard className="col-span-2">
      <PanelCardHeader>
        <PanelCardIcon tone="selected">
          <Sparkles />
        </PanelCardIcon>
        <PanelCardHeading>
          <PanelCardTitle>What {a.name} can do</PanelCardTitle>
          <PanelCardDescription>Sorted by whose money it is. A new agent starts with none.</PanelCardDescription>
        </PanelCardHeading>
      </PanelCardHeader>
      <PanelCardContent className="flex flex-col">
        {error && (
          <Alert variant="destructive" severityLabel="Not saved" className="mb-3" action={<Button size="xs" variant="ghost" onClick={() => setError(null)}>Dismiss</Button>}>
            <AlertTitle>The server said no</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Accordion type="multiple" value={open} onValueChange={(v) => setFolded(on.filter((x) => !v.includes(x)))}>
          <MoneySection
            value="wallet"
            icon={<Wallet />}
            title="Spend from its own wallet"
            text="Pays from its own wallet: per use for APIs, data or compute, sends to saved payees, and swaps."
            on={ab.buy}
            onChange={(v) => turn("wallet", "buy", v)}
            agent={a.name}
          >
            <div className="grid grid-cols-2 items-start gap-4">
              <QuotaTile icon={Coins} label="Spent today" used={a.usage.purchasesToday} limit={s.apiPerDay} srLabel="Spent from its wallet today" {...tile} />
              <DescriptionList layout="divided" items={rows(["apiPerPayment", "apiPerDay", "askAbove"])} />
            </div>
            <Item variant="outline" size="sm">
              <ItemMedia variant="icon">
                <RefreshCw />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Refill from the treasury</ItemTitle>
                <ItemDescription>
                  {!ab.pettyCash
                    ? "Off: it only spends what's already in its wallet."
                    : a.onchain.pettyCashPerWeekUsd > 0
                      ? `Up to ${usd(s.pcPerWeek)} a week, at most ${usd(s.pcPerRequest)} a time, without asking · ${usd(refillLeft)} left this week. The treasury contract enforces it.`
                      : `Up to ${usd(s.pcPerWeek)} a week, at most ${usd(s.pcPerRequest)} a time, without asking. An approver sets it on the treasury contract first.`}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch checked={ab.pettyCash} onCheckedChange={(v) => void save(onAbility("pettyCash", v))} aria-label={`${a.name}: refill from the treasury`} />
              </ItemActions>
            </Item>
            {/* Circle App Kit swaps on Arc: USDC into an allowed token; the USDC counts toward the limits above */}
            <Item variant="outline" size="sm">
              <ItemMedia variant="icon">
                <ArrowLeftRight />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Swaps</ItemTitle>
                <ItemDescription>
                  {(a.controls.allowedSwapTokens ?? []).length
                    ? `USDC into ${(a.controls.allowedSwapTokens ?? []).join(", ")}, the price moving at most ${fmt("swapMove", s.swapMove)}. The tokens come back to its wallet.`
                    : "Off: it can't swap. Add a token to allow it."}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {tokens.map((t) => (
                  <Tag key={t} variant="secondary" onDismiss={() => list("allowedSwapTokens", tokens.filter((x) => x !== t))} dismissLabel={`Stop swaps into ${t}`}>
                    {t}
                  </Tag>
                ))}
                <AddMenu label="Add token" options={(addable?.tokens ?? []).filter((t) => !tokens.includes(t)).map((t) => ({ id: t, name: t }))} onPick={(t) => list("allowedSwapTokens", [...tokens, t])} />
              </ItemActions>
            </Item>
            <WhoItPays label="Sellers it can pay per use (it can also send to the saved payees below)">
              {sellers.map((x) => (
                <Tag key={x} variant="secondary" onDismiss={() => list("allowedSellers", sellers.filter((y) => y !== x))} dismissLabel={`Remove ${x}`}>
                  {x}
                </Tag>
              ))}
              <AddSeller onAdd={(host) => list("allowedSellers", [...sellers, host])} />
            </WhoItPays>
            <ChangeButton onClick={() => setSheet("wallet")} />
          </MoneySection>

          <MoneySection
            value="treasury"
            icon={<Landmark />}
            title="Ask to pay from the treasury"
            text="Asks to pay saved payees from the company treasury. A person always approves."
            on={ab.draft}
            onChange={(v) => turn("treasury", "draft", v)}
            agent={a.name}
          >
            <div className="grid grid-cols-2 items-start gap-4">
              <QuotaTile icon={Landmark} label="Asked today" used={a.usage.draftsToday} limit={s.draftPerDay} srLabel="Treasury payments asked for today" {...tile} />
              <DescriptionList layout="divided" items={rows(["draftPerPayment", "draftPerDay"])} />
            </div>
            <WhoItPays label="Payees it can ask to pay">
              {a.controls.allowedPayees.map((p) => (
                <Tag key={p.address} variant="secondary" onDismiss={() => list("allowedPayees", payees.filter((x) => x !== p.address))} dismissLabel={`Remove ${p.name}`}>
                  {p.name} · <AddressLine address={p.address} label={`${p.name}'s address`} />
                </Tag>
              ))}
              <AddMenu
                label="Add payee"
                icon={<UserPlus />}
                options={(addable?.payees ?? []).filter((p) => !payees.includes(p.address.toLowerCase())).map((p) => ({ id: p.address.toLowerCase(), name: p.name }))}
                empty="Every saved contact is already a payee. Save a new contact first."
                onPick={(addr) => list("allowedPayees", [...payees, addr])}
              />
            </WhoItPays>
            <ChangeButton onClick={() => setSheet("treasury")} />
          </MoneySection>
        </Accordion>

        {/* applies to every payment, whichever money it is: always here, so nothing moves when a section opens */}
        <Item size="sm" className="mt-2 border-t px-0 pt-4">
          <ItemMedia variant="icon">
            <Gauge />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Speed limit</ItemTitle>
            <ItemDescription>
              At most {s.perHour} payments an hour, across both · {a.usage.paymentsThisHour} this hour
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button size="sm" variant="outline" onClick={() => setSheet("speed")}>
              Change
            </Button>
          </ItemActions>
        </Item>
      </PanelCardContent>

      <LimitsSheet
        d={d}
        keys={KEYS[sheet ?? "wallet"]}
        title={sheet === "treasury" ? `${a.name}'s treasury limits` : sheet === "speed" ? `${a.name}'s speed limit` : `${a.name}'s wallet limits`}
        open={sheet !== null}
        onOpenChange={(o) => !o && setSheet(null)}
        onSave={onSaveLimits}
      />
    </PanelCard>
  );
}

/** Add one of a few choices (a token, a saved contact): Pesto Popover over a list of buttons. */
function AddMenu({ label, icon, options, onPick, empty = "Nothing else to add." }: { label: string; icon?: React.ReactNode; options: { id: string; name: string }[]; onPick: (id: string) => void; empty?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="xs" variant="outline">
          {icon}
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="flex w-60 flex-col gap-1 p-2">
        {options.length ? (
          options.map((o) => (
            <Button
              key={o.id}
              size="sm"
              variant="ghost"
              className="justify-start"
              onClick={() => {
                setOpen(false);
                onPick(o.id);
              }}
            >
              {o.name}
            </Button>
          ))
        ) : (
          <p className="p-2 text-xs text-muted-foreground">{empty}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** A paid-API seller is typed in: host[:port][/path], as the allowlist matches it. */
function AddSeller({ onAdd }: { onAdd: (host: string) => void }) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState("");
  const ok = /^[a-z0-9.-]+(:\d+)?(\/[\w\-./]*)?$/i.test(host.trim());
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="xs" variant="outline">
          <Store /> Add seller
        </Button>
      </PopoverTrigger>
      <PopoverContent className="flex w-72 flex-col gap-2 p-3">
        <Input placeholder="x402.quicknode.com" value={host} onChange={(e) => setHost(e.target.value)} aria-label="Seller host" />
        <Button
          size="sm"
          disabled={!ok}
          onClick={() => {
            setOpen(false);
            onAdd(host.trim());
            setHost("");
          }}
        >
          Add seller
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/** One kind of money: a Pesto Accordion item whose header carries the switch (outside the trigger: no button in a button). */
function MoneySection({
  value,
  icon,
  title,
  text,
  on,
  onChange,
  agent,
  children,
}: {
  value: Section;
  icon: React.ReactNode;
  title: string;
  text: string;
  on: boolean;
  onChange: (v: boolean) => void;
  agent: string;
  children: React.ReactNode;
}) {
  return (
    <AccordionItem value={value}>
      <div className="flex items-center gap-4 [&>h3]:min-w-0 [&>h3]:flex-1">
        <AccordionTrigger disabled={!on} className="gap-3">
          <span className="flex items-start gap-3">
            <span className="mt-0.5 text-muted-foreground [&>svg]:size-4.5">{icon}</span>
            <span className="flex flex-col gap-0.5">
              <span>{title}</span>
              <span className="text-sm font-normal text-muted-foreground">{text}</span>
            </span>
          </span>
        </AccordionTrigger>
        <Switch checked={on} onCheckedChange={onChange} aria-label={`${agent}: ${title}`} />
      </div>
      <AccordionContent className="flex flex-col gap-4 pt-1 text-foreground">{children}</AccordionContent>
    </AccordionItem>
  );
}

function WhoItPays({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function ChangeButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="flex justify-end">
      <Button size="sm" variant="outline" onClick={onClick}>
        <Pencil /> Change limits
      </Button>
    </div>
  );
}
