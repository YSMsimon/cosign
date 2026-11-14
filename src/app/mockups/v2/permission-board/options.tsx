"use client";

import {
  Bot,
  CircleCheck,
  Coins,
  ExternalLink,
  Gauge,
  Hand,
  Landmark,
  Lock,
  PiggyBank,
  ShieldCheck,
  Snowflake,
  Sparkles,
  Store,
  Timer,
  UserPlus,
  Users,
  Wallet,
} from "lucide-react";
import { ActivityFeed, ActivityFeedItem } from "@/components/activity-feed";
import { Field } from "@/components/field";
import { MetricCard } from "@/components/metric-card";
import { PanelCard, PanelCardAction, PanelCardContent, PanelCardDescription, PanelCardHeader, PanelCardHeading, PanelCardIcon, PanelCardTitle } from "@/components/panel-card";
import { SegmentedBar } from "@/components/segmented-bar";
import { Stat } from "@/components/stat";
import { UsageCard, UsageCardAction, UsageCardBadge, UsageCardDescription, UsageCardIcon, UsageCardMeter, UsageCardTitle } from "@/components/usage-card";
import { UsageMeter } from "@/components/usage-meter";
import { UserRow } from "@/components/user-row";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Banner, BannerDescription, BannerTitle } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Stepper, StepperItem } from "@/components/ui/stepper";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard, TableCardBody } from "@/components/ui/table-card";
import { Tag } from "@/components/ui/tag";
import { AgentOrb, ApprovalRow } from "../parts";
import { AgentRank, BalanceSpark, BudgetRadial, HourlyBars, SpendingChart, SplitDonut } from "./charts";
import { ABILITIES, clerk, treasury, usd } from "./mock";
import { AddressLine } from "../money";

const c = clerk.controls;
const u = clerk.usage;

function Money({ id, value }: { id: string; value: number }) {
  return (
    <InputGroup>
      <InputGroupAddon>
        <InputGroupText>$</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput id={id} defaultValue={value} inputMode="decimal" />
    </InputGroup>
  );
}

/* ───────────── A. Settings panels: one Pesto Panel Card per control, form rows inside ───────────── */
export function SettingsPanels() {
  return (
    <div className="grid grid-cols-2 gap-4">
      <PanelCard>
        <PanelCardHeader>
          <PanelCardIcon tone="selected">
            <Sparkles />
          </PanelCardIcon>
          <PanelCardHeading>
            <PanelCardTitle>What Clerk can do</PanelCardTitle>
            <PanelCardDescription>A new agent starts with no money.</PanelCardDescription>
          </PanelCardHeading>
        </PanelCardHeader>
        <PanelCardContent className="flex flex-col gap-1">
          {ABILITIES.map((a) => (
            <Item key={a.key} size="sm" className="px-0">
              <ItemContent>
                <ItemTitle>{a.title}</ItemTitle>
                <ItemDescription>{a.text}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch defaultChecked={a.on} aria-label={a.title} />
              </ItemActions>
            </Item>
          ))}
        </PanelCardContent>
      </PanelCard>

      <PanelCard>
        <PanelCardHeader>
          <PanelCardIcon tone="info">
            <Coins />
          </PanelCardIcon>
          <PanelCardHeading>
            <PanelCardTitle>Spending limits</PanelCardTitle>
            <PanelCardDescription>Checked by our server before Clerk&apos;s wallet signs.</PanelCardDescription>
          </PanelCardHeading>
        </PanelCardHeader>
        <PanelCardContent className="flex flex-col gap-5">
          {(
            [
              ["API purchases", "p", c.purchases, u.purchasesToday],
              ["Treasury drafts", "d", c.drafts, u.draftsToday],
            ] as const
          ).map(([label, id, l, used]) => (
            <div key={id} className="flex flex-col gap-3">
              <span className="text-sm font-medium">{label}</span>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Per payment" htmlFor={`${id}-pp`}>
                  <Money id={`${id}-pp`} value={l.perPayment} />
                </Field>
                <Field label="Per day" htmlFor={`${id}-day`}>
                  <Money id={`${id}-day`} value={l.daily} />
                </Field>
              </div>
              <UsageMeter variant="bar" size="sm" label={`Today · ${usd(used)} of ${usd(l.daily)}`} value={used} max={l.daily} />
            </div>
          ))}
        </PanelCardContent>
      </PanelCard>

      <PanelCard>
        <PanelCardHeader>
          <PanelCardIcon tone="warning">
            <Hand />
          </PanelCardIcon>
          <PanelCardHeading>
            <PanelCardTitle>Ask a person, and speed</PanelCardTitle>
            <PanelCardDescription>Above the line, a member OKs it in the chat.</PanelCardDescription>
          </PanelCardHeading>
        </PanelCardHeader>
        <PanelCardContent className="flex flex-col gap-5">
          <Field label="Ask a person above" htmlFor="ask" hint="API purchases above this wait for a member's OK.">
            <Money id="ask" value={c.askAboveUsd} />
          </Field>
          <Field label={`At most ${c.maxPaymentsPerHour} payments an hour`} hint={`${u.paymentsThisHour} this hour, purchases and drafts together.`}>
            <Slider defaultValue={[c.maxPaymentsPerHour]} max={60} step={1} aria-label="Payments per hour" />
          </Field>
        </PanelCardContent>
      </PanelCard>

      <PanelCard>
        <PanelCardHeader>
          <PanelCardIcon tone="success">
            <ShieldCheck />
          </PanelCardIcon>
          <PanelCardHeading>
            <PanelCardTitle>Who and what it can pay</PanelCardTitle>
            <PanelCardDescription>Everything else is blocked.</PanelCardDescription>
          </PanelCardHeading>
        </PanelCardHeader>
        <PanelCardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Payees</span>
            <div className="flex flex-wrap gap-2">
              {c.allowedPayees.map((p) => (
                <Tag key={p.address} variant="secondary" onDismiss={() => {}} dismissLabel={`Remove ${p.name}`}>
                  {p.name} · <AddressLine address={p.address} label={`${p.name}'s address`} />
                </Tag>
              ))}
              <Button size="xs" variant="outline">
                <UserPlus /> Add payee
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">APIs</span>
            <div className="flex flex-wrap gap-2">
              {c.allowedSellers.map((s) => (
                <Tag key={s} variant="secondary" onDismiss={() => {}} dismissLabel={`Remove ${s}`}>
                  {s}
                </Tag>
              ))}
            </div>
          </div>
        </PanelCardContent>
      </PanelCard>

      <PanelCard>
        <PanelCardHeader>
          <PanelCardIcon tone="selected">
            <PiggyBank />
          </PanelCardIcon>
          <PanelCardHeading>
            <PanelCardTitle>Petty cash</PanelCardTitle>
            <PanelCardDescription>The weekly allowance lives on the treasury contract.</PanelCardDescription>
          </PanelCardHeading>
          <PanelCardAction>
            <Tag variant="success" size="sm">
              On the contract
            </Tag>
          </PanelCardAction>
        </PanelCardHeader>
        <PanelCardContent className="flex flex-col gap-4">
          <Stat value={usd(clerk.onchain.pettyCashLeftUsd)} label={`left of ${usd(clerk.onchain.pettyCashPerWeekUsd)} this week`} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Per week" htmlFor="pc-week" hint="Changing it needs an approver's signature.">
              <Money id="pc-week" value={c.pettyCashPerWeekUsd} />
            </Field>
            <Field label="Per request" htmlFor="pc-req">
              <Money id="pc-req" value={c.topUpMaxUsd} />
            </Field>
          </div>
        </PanelCardContent>
      </PanelCard>

      <PanelCard>
        <PanelCardHeader>
          <PanelCardIcon tone="destructive">
            <Snowflake />
          </PanelCardIcon>
          <PanelCardHeading>
            <PanelCardTitle>Emergency</PanelCardTitle>
            <PanelCardDescription>Stop all money at once, or set an end date.</PanelCardDescription>
          </PanelCardHeading>
        </PanelCardHeader>
        <PanelCardContent className="flex flex-col gap-4">
          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemTitle>Freeze Clerk</ItemTitle>
              <ItemDescription>No payments, drafts or petty cash until unfrozen.</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch aria-label="Freeze Clerk" />
            </ItemActions>
          </Item>
          <Field label="Money switches off">
            <Select defaultValue="never">
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="never">Never</SelectItem>
                <SelectItem value="7">In 7 days</SelectItem>
                <SelectItem value="30">In 30 days</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </PanelCardContent>
      </PanelCard>

      <div className="col-span-2 flex items-center justify-between rounded-2xl bg-secondary/50 px-4 py-3 text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <Lock className="size-4" /> Loosening a limit needs All access. Anyone who manages Clerk can tighten.
        </span>
        <Button size="sm">Save changes</Button>
      </div>
    </div>
  );
}

/* ───────────── B. Control tiles with charts: shadcn charts (on Pesto Chart) + Pesto Rank List, Metric Card, Usage Card ───────────── */
export function ControlTiles() {
  return (
    <div className="grid grid-cols-3 gap-4">
      <div className="col-span-3">
        <SpendingChart />
      </div>
      <BudgetRadial />
      <HourlyBars />
      <SplitDonut />
      <AgentRank />
      <MetricCard label="Per payment" value={`${usd(c.purchases.perPayment)} · ${usd(c.drafts.perPayment)}`} icon={<Gauge />} deltaLabel="API purchases · treasury drafts" />
      <MetricCard label="Ask a person above" value={usd(c.askAboveUsd)} icon={<Hand />} deltaLabel="A member OKs it in the chat" />
      <UsageCard tone="selected">
        <UsageCardIcon>
          <PiggyBank />
        </UsageCardIcon>
        <UsageCardTitle>
          Petty cash this week
          <UsageCardBadge>Onchain</UsageCardBadge>
        </UsageCardTitle>
        <UsageCardDescription>
          {usd(clerk.onchain.pettyCashLeftUsd)} left of {usd(clerk.onchain.pettyCashPerWeekUsd)}.
        </UsageCardDescription>
        <UsageCardMeter>
          <UsageMeter variant="bar" size="sm" value={clerk.onchain.pettyCashPerWeekUsd - clerk.onchain.pettyCashLeftUsd} max={clerk.onchain.pettyCashPerWeekUsd} srLabel="Petty cash used" />
        </UsageCardMeter>
        <UsageCardAction>
          <Button size="sm" variant="outline" className="w-full">
            Change
          </Button>
        </UsageCardAction>
      </UsageCard>
      <UsageCard tone="success">
        <UsageCardIcon>
          <ShieldCheck />
        </UsageCardIcon>
        <UsageCardTitle>Who it can pay</UsageCardTitle>
        <UsageCardDescription>
          {c.allowedPayees.length} payee and {c.allowedSellers.length} APIs. Everything else is blocked.
        </UsageCardDescription>
        <UsageCardAction>
          <Button size="sm" variant="outline" className="w-full">
            Manage
          </Button>
        </UsageCardAction>
      </UsageCard>
      <UsageCard tone="destructive">
        <UsageCardIcon>
          <Snowflake />
        </UsageCardIcon>
        <UsageCardTitle>Freeze</UsageCardTitle>
        <UsageCardDescription>Stops every payment, draft and petty-cash draw at once.</UsageCardDescription>
        <UsageCardAction>
          <Button size="sm" variant="destructive" className="w-full">
            Freeze Clerk
          </Button>
        </UsageCardAction>
      </UsageCard>
    </div>
  );
}

/* ───────────── C. Rule pipeline: Pesto Stepper (vertical), the checks in the order the server runs them ───────────── */
export function RulePipeline() {
  const steps = [
    { icon: <Sparkles />, title: "Is the ability on?", description: "Pays for APIs: on · Drafts treasury payments: on" },
    { icon: <Store />, title: "Is the seller or payee allowed?", description: `${c.allowedSellers.length} APIs · ${c.allowedPayees.length} payee (Lena). Clerk also checks the name against the address.` },
    { icon: <Gauge />, title: "Under the per-payment cap?", description: `API purchases ${usd(c.purchases.perPayment)} · treasury drafts ${usd(c.drafts.perPayment)}` },
    { icon: <Coins />, title: "Within the budget?", description: `Today ${usd(u.purchasesToday)} of ${usd(c.purchases.daily)} on APIs · ${usd(u.draftsToday)} of ${usd(c.drafts.daily)} in drafts` },
    { icon: <Timer />, title: "Under the speed limit?", description: `${u.paymentsThisHour} of ${c.maxPaymentsPerHour} payments this hour` },
    { icon: <Hand />, title: "Above the ask-a-person line?", description: `Over ${usd(c.askAboveUsd)}, a member OKs it in the chat first` },
    { icon: <Wallet />, title: "Clerk's wallet signs", description: "API purchases are paid from Clerk's own wallet" },
    { icon: <Users />, title: "Approvers sign the treasury draft", description: `Drafts wait for ${treasury.threshold} of ${treasury.approvers.length} approvers, then the contract pays` },
  ];
  return (
    <div className="grid grid-cols-[1fr_16rem] gap-6">
      <Stepper variant="vertical" labels="end" activeStep={steps.length}>
        {steps.map((s) => (
          <StepperItem key={s.title} icon={s.icon} title={s.title} description={s.description} />
        ))}
      </Stepper>
      <Banner variant="info" icon={<CircleCheck />} className="self-start">
        <BannerTitle>Every payment, in this order</BannerTitle>
        <BannerDescription>Any step that fails stops the payment, and Clerk says which company rule it hit. Click a step to change it.</BannerDescription>
      </Banner>
    </div>
  );
}

/* ───────────── E. Vault overview: Metric Card, approvers, where money went, open proposals, onchain activity ───────────── */
export function VaultOverview() {
  const w = treasury.thisWeek;
  return (
    <div className="grid grid-cols-3 gap-4">
      <MetricCard label={`${treasury.name} · ${treasury.chain}`} value={`${usd(treasury.balanceUsd)} USDC`} icon={<Landmark />} delta={-6.8} deltaLabel="this week" chart={<BalanceSpark />} />
      <PanelCard>
        <PanelCardHeader>
          <PanelCardIcon tone="selected">
            <Users />
          </PanelCardIcon>
          <PanelCardHeading>
            <PanelCardTitle>Approvers</PanelCardTitle>
            <PanelCardDescription>
              {treasury.threshold} of {treasury.approvers.length} must sign
            </PanelCardDescription>
          </PanelCardHeading>
          <PanelCardAction>
            <Button size="xs" variant="outline">
              Change
            </Button>
          </PanelCardAction>
        </PanelCardHeader>
        <PanelCardContent className="flex flex-col gap-2">
          {treasury.approvers.map((a) => (
            <UserRow
              key={a.wallet}
              size="sm"
              avatar={
                <Avatar className="size-8">
                  <AvatarFallback>{a.initials}</AvatarFallback>
                </Avatar>
              }
              label={a.name}
              sublabel={<AddressLine address={a.wallet} label={`${a.name}'s wallet address`} />}
              action={a.you ? <Tag size="sm">You</Tag> : undefined}
            />
          ))}
          <UsageMeter variant="pips" size="sm" value={treasury.threshold} max={treasury.approvers.length} label="Signatures needed" />
        </PanelCardContent>
      </PanelCard>
      <PanelCard>
        <PanelCardHeader>
          <PanelCardIcon tone="info">
            <Coins />
          </PanelCardIcon>
          <PanelCardHeading>
            <PanelCardTitle>Where money went this week</PanelCardTitle>
            <PanelCardDescription>{usd(w.apiPurchases + w.pettyCash + w.payments)} in total</PanelCardDescription>
          </PanelCardHeading>
        </PanelCardHeader>
        <PanelCardContent>
          <SegmentedBar
            showLegend
            segments={[
              { id: "pay", label: "Treasury payments", value: w.payments, tone: "selected" },
              { id: "pc", label: "Petty cash", value: w.pettyCash, tone: "warning" },
              { id: "api", label: "Agents' API purchases", value: w.apiPurchases, tone: "info" },
            ]}
          />
        </PanelCardContent>
      </PanelCard>
      <PanelCard className="col-span-2">
        <PanelCardHeader>
          <PanelCardIcon tone="warning">
            <Hand />
          </PanelCardIcon>
          <PanelCardHeading>
            <PanelCardTitle>Waiting for you</PanelCardTitle>
            <PanelCardDescription>Treasury drafts and over-the-line purchases.</PanelCardDescription>
          </PanelCardHeading>
        </PanelCardHeader>
        <PanelCardContent className="flex flex-col gap-3">
          <ApprovalRow
            icon={<Wallet />}
            title="Approve $2.40 to Lena?"
            description="Proposal #5 · drafted by Clerk · you sign in your own wallet"
            approved="Approved · paid $2.40 to Lena"
            denied="Denied · nothing was paid"
            pending={["Connecting to your wallet…", "Waiting for your signature…", "Sending your approval to the treasury on Arc…"]}
          />
          <ApprovalRow
            icon={<Coins />}
            title="Let Clerk pay $0.10 for a credit report?"
            description="Over Clerk's $0.05 ask-a-person line"
            approved="OK'd · Clerk paid $0.10"
            denied="Denied · nothing was paid"
            pending={["Telling Clerk it's OK…"]}
          />
        </PanelCardContent>
      </PanelCard>
      <PanelCard>
        <PanelCardHeader>
          <PanelCardHeading>
            <PanelCardTitle>Onchain activity</PanelCardTitle>
            <PanelCardDescription>From the QuickNode stream</PanelCardDescription>
          </PanelCardHeading>
        </PanelCardHeader>
        <PanelCardContent>
          <ActivityFeed>
            <ActivityFeedItem tone="info" icon={<Bot />} title="Clerk drafted proposal #5" description="$2.40 to Lena" timestamp="2 min ago" />
            <ActivityFeedItem tone="success" icon={<CircleCheck />} title="Proposal #4 paid" description="$3 · approved by Priya" timestamp="1 h ago" />
            <ActivityFeedItem tone="warning" icon={<PiggyBank />} title="Clerk drew petty cash" description="$0.60 of $2 this week" timestamp="Yesterday" />
          </ActivityFeed>
        </PanelCardContent>
      </PanelCard>
    </div>
  );
}

/* ───────────── F. Vault ledger: every proposal as a row (Pesto Table Card) ───────────── */
export function VaultLedger() {
  const tone = { open: "warning", paid: "success", done: "success", cancelled: "secondary" } as const;
  const word = { open: "Waiting", paid: "Paid", done: "Done", cancelled: "Cancelled" } as const;
  return (
    <TableCard>
      <TableCardBody>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Drafted by</TableHead>
              <TableHead>Approvals</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {treasury.proposals.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="text-muted-foreground tabular-nums">#{p.id}</TableCell>
                <TableCell className="font-medium">{p.to}</TableCell>
                <TableCell className="tabular-nums">{p.amount ? usd(p.amount) : "–"}</TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1.5">
                    {p.by === "Clerk" ? (
                      <AgentOrb hue="blue" still className="size-5" />
                    ) : (
                      <Avatar className="size-5">
                        <AvatarFallback className="text-[0.55rem]">SY</AvatarFallback>
                      </Avatar>
                    )}
                    {p.by}
                  </span>
                </TableCell>
                <TableCell className="tabular-nums">
                  {p.approvals} of {treasury.threshold}
                </TableCell>
                <TableCell>
                  <Tag variant={tone[p.status]} size="sm">
                    {word[p.status]}
                  </Tag>
                </TableCell>
                <TableCell className="text-right">
                  {p.status === "open" ? (
                    <Button size="xs">Approve</Button>
                  ) : (
                    <Button size="xs" variant="ghost" aria-label={`Proposal ${p.id} on the explorer`}>
                      <ExternalLink />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableCardBody>
    </TableCard>
  );
}
