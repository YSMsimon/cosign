"use client";

import {
  Activity,
  AudioLines,
  Bot,
  ChevronDown,
  CircleDollarSign,
  Hash,
  Inbox,
  Landmark,
  LayoutDashboard,
  Settings,
  ShoppingCart,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemSeparator, ItemTitle } from "@/components/ui/item";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentAvatar, agents, PersonAvatar, StatusDot } from "../parts";

const nav = [
  { icon: LayoutDashboard, label: "Overview", active: true },
  { icon: Inbox, label: "Approvals", badge: 3 },
  { icon: Hash, label: "Rooms" },
  { icon: Bot, label: "Agents" },
  { icon: Landmark, label: "Treasury" },
  { icon: Activity, label: "Activity" },
  { icon: Users, label: "Members" },
  { icon: Settings, label: "Settings" },
];

const stats = [
  { label: "Treasury", value: "$2.50", note: "USDC on Arc · 1 of 1 cosign" },
  { label: "Waiting for your cosign", value: "2", note: "oldest 3 h" },
  { label: "Agent spend today", value: "$0.06", note: "of $0.50 in limits" },
  { label: "Agents working", value: "1 of 2", note: "Clerk: invoice 121" },
];

const feed = [
  { what: "Proposal #5 drafted by Clerk", amount: "$2.40", when: "2 min ago" },
  { what: "Petty cash to Clerk's wallet", amount: "$1.00", when: "6 min ago" },
  { what: "Nanopayment: vendor check (Lena)", amount: "$0.02", when: "9 min ago" },
  { what: "Proposal #3 cosigned by Simon", amount: "$5.00", when: "yesterday" },
];

/** Option B: the operations board. Money first: what needs a cosign, what agents are doing, what moved. */
export default function OperationsBoard() {
  return (
    <div className="flex h-screen bg-muted/30 text-foreground">
      <aside className="flex w-60 flex-col border-r bg-background">
        <Button variant="ghost" className="m-3 h-auto justify-start gap-2 px-2 py-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">C</div>
          <div className="grid text-left">
            <span className="text-sm font-semibold">Nova Labs</span>
            <span className="text-xs text-muted-foreground">Cosign workspace</span>
          </div>
          <ChevronDown className="ml-auto text-muted-foreground" />
        </Button>
        <div className="grid gap-0.5 px-2">
          {nav.map((n) => (
            <Button key={n.label} variant={n.active ? "secondary" : "ghost"} className="justify-start font-normal">
              <n.icon />
              {n.label}
              {n.badge && <Badge className="ml-auto">{n.badge}</Badge>}
            </Button>
          ))}
        </div>
        <div className="px-4 pt-6 pb-2 text-xs font-medium text-muted-foreground">Agents</div>
        <div className="grid gap-1 px-4 text-sm">
          {agents.map((a) => (
            <div key={a.id} className="flex items-center gap-2">
              <StatusDot status={a.status} />
              {a.name}
              <span className="ml-auto text-xs text-muted-foreground capitalize">{a.status}</span>
            </div>
          ))}
        </div>
        <div className="mt-auto flex items-center gap-2 border-t p-3">
          <PersonAvatar initials="SY" />
          <div className="grid text-sm">
            <span className="font-medium">Simon</span>
            <span className="text-xs text-muted-foreground">CFO · Approver</span>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-auto p-6">
        <div className="mb-5 flex items-center gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Overview</h1>
            <p className="text-sm text-muted-foreground">2 payments wait for your cosign. Clerk is reading invoice 121.</p>
          </div>
          <Tabs defaultValue="7" className="ml-auto">
            <TabsList>
              <TabsTrigger value="1">Today</TabsTrigger>
              <TabsTrigger value="7">7 days</TabsTrigger>
              <TabsTrigger value="30">30 days</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button>
            <AudioLines /> Talk to an agent
          </Button>
        </div>

        <div className="mb-5 grid grid-cols-4 gap-4">
          {stats.map((s) => (
            <Card key={s.label} className="gap-1 py-4">
              <CardHeader className="px-4">
                <CardDescription>{s.label}</CardDescription>
                <CardTitle className="text-2xl tabular-nums">{s.value}</CardTitle>
              </CardHeader>
              <CardContent className="px-4 text-xs text-muted-foreground">{s.note}</CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Card className="col-span-2">
            <CardHeader>
              <CardTitle>Needs you</CardTitle>
              <CardDescription>Agents draft; only people cosign, from their own wallets.</CardDescription>
              <CardAction>
                <Badge variant="secondary">3</Badge>
              </CardAction>
            </CardHeader>
            <CardContent>
              <ItemGroup>
                {[5, 4].map((id) => (
                  <div key={id}>
                    <Item variant="outline">
                      <ItemMedia variant="icon">
                        <CircleDollarSign />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>
                          Proposal #{id} · $2.40 to Lena (contractor)
                        </ItemTitle>
                        <ItemDescription>Invoice 120 · drafted by Clerk · checks passed · 0 of 1 cosigns</ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Button size="sm" variant="outline">
                          Reject
                        </Button>
                        <Button size="sm">Cosign</Button>
                      </ItemActions>
                    </Item>
                    <ItemSeparator className="my-2 opacity-0" />
                  </div>
                ))}
                <Item variant="outline">
                  <ItemMedia variant="icon">
                    <ShoppingCart />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>Clerk wants to buy market data · $0.08</ItemTitle>
                    <ItemDescription>Above its $0.05 ask-first limit · from Clerk&apos;s own wallet</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button size="sm" variant="outline">
                      Deny
                    </Button>
                    <Button size="sm" variant="secondary">
                      Approve
                    </Button>
                  </ItemActions>
                </Item>
              </ItemGroup>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Agents</CardTitle>
              <CardDescription>Spending today against each agent&apos;s limits</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              {agents.map((a) => (
                <div key={a.id} className="grid gap-2">
                  <div className="flex items-center gap-2">
                    <AgentAvatar className="size-7" />
                    <div className="grid">
                      <span className="text-sm font-medium">{a.name}</span>
                      <span className="text-xs text-muted-foreground">{a.note}</span>
                    </div>
                    <StatusDot status={a.status} />
                    {a.grokBot && (
                      <Badge variant="outline" className="ml-auto">
                        Grok Bot
                      </Badge>
                    )}
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Drafts</span>
                    <span>{a.id === "clerk" ? "$2.40 of $20" : "read-only"}</span>
                  </div>
                  <Progress value={a.id === "clerk" ? 12 : 0} />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="col-span-3">
            <CardHeader>
              <CardTitle>Live treasury activity</CardTitle>
              <CardDescription>Straight from the chain (QuickNode stream on Arc testnet)</CardDescription>
            </CardHeader>
            <CardContent>
              {feed.map((f, i) => (
                <div key={f.what}>
                  {i > 0 && <Separator className="my-2" />}
                  <div className="flex items-center gap-3 text-sm">
                    <Activity className="size-4 text-muted-foreground" />
                    <span>{f.what}</span>
                    <span className="ml-auto font-medium tabular-nums">{f.amount}</span>
                    <span className="w-24 text-right text-xs text-muted-foreground">{f.when}</span>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
