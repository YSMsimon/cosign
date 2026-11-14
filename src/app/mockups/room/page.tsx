"use client";

import { AudioLines, Bell, Bot, CalendarClock, Cpu, Hash, Inbox, Landmark, MessageSquare, Search, Settings, Users, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Message, MessageAvatar, MessageContent, MessageGroup, MessageHeader } from "@/components/ui/message";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentAvatar, AgentRun, agents, Composer, CosignCard, PersonAvatar, people, rooms, StatusDot, WalletSummary } from "../parts";

/** Option A: the team room. People and agents work in rooms; drafts show up as cosign cards in the thread. */
export default function TeamRoom() {
  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* icon rail */}
      <nav className="flex w-14 flex-col items-center gap-1 border-r py-3">
        <div className="mb-3 flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">C</div>
        {[MessageSquare, Inbox, Bot, Landmark, Users].map((Icon, i) => (
          <Button key={i} size="icon" variant={i === 0 ? "secondary" : "ghost"}>
            <Icon />
          </Button>
        ))}
        <div className="mt-auto flex flex-col items-center gap-1">
          <Button size="icon" variant="ghost">
            <Settings />
          </Button>
          <PersonAvatar initials="SY" />
        </div>
      </nav>

      {/* rooms, agents, people */}
      <aside className="flex w-64 flex-col border-r">
        <div className="flex items-center justify-between px-4 pt-4 pb-3">
          <div>
            <div className="font-semibold">Nova Labs</div>
            <div className="text-xs text-muted-foreground">Treasury on Arc · 1 of 1 to cosign</div>
          </div>
          <Button size="icon-sm" variant="ghost">
            <Bell />
          </Button>
        </div>
        <div className="px-3 pb-3">
          <div className="relative">
            <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input placeholder="Search" className="pl-8" />
          </div>
        </div>
        <div className="flex-1 overflow-auto px-2 text-sm">
          <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">Rooms</div>
          {rooms.map((r) => (
            <Button key={r.name} variant={r.name === "invoices" ? "secondary" : "ghost"} className="w-full justify-start font-normal">
              <Hash className="text-muted-foreground" />
              {r.name}
              {r.unread > 0 && <Badge className="ml-auto">{r.unread}</Badge>}
            </Button>
          ))}
          <div className="px-2 pt-4 pb-1 text-xs font-medium text-muted-foreground">Agents</div>
          {agents.map((a) => (
            <Button key={a.id} variant="ghost" className="h-auto w-full justify-start py-1.5 font-normal">
              <AgentAvatar className="size-6" />
              <div className="grid text-left">
                <span className="flex items-center gap-1.5">
                  {a.name}
                  {a.grokBot && (
                    <Badge variant="outline" className="h-4 px-1 text-[10px]">
                      Grok Bot
                    </Badge>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">{a.note}</span>
              </div>
              <span className="ml-auto">
                <StatusDot status={a.status} />
              </span>
            </Button>
          ))}
          <div className="px-2 pt-4 pb-1 text-xs font-medium text-muted-foreground">People</div>
          {people.map((p) => (
            <Button key={p.name} variant="ghost" className="w-full justify-start font-normal">
              <PersonAvatar initials={p.initials} className="size-6" />
              {p.name}
              <span className="ml-auto text-xs text-muted-foreground">{p.role}</span>
            </Button>
          ))}
        </div>
      </aside>

      {/* the conversation */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b px-5 py-3">
          <Hash className="size-4 text-muted-foreground" />
          <span className="font-semibold">invoices</span>
          <span className="text-sm text-muted-foreground">Vendor invoices. Clerk drafts the payments.</span>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost">
              <Zap /> Automations
            </Button>
            <Button size="sm" variant="ghost">
              <Users /> 5
            </Button>
          </div>
        </header>
        <div className="flex-1 overflow-auto px-6 py-5">
          <MessageGroup className="mx-auto max-w-3xl gap-6">
            <Message>
              <MessageAvatar>
                <PersonAvatar initials="PR" />
              </MessageAvatar>
              <MessageContent>
                <MessageHeader>Priya · 2:01 PM</MessageHeader>
                <Bubble variant="muted">
                  <BubbleContent>Lena sent invoice 120 for the frontend work. @Clerk can you handle it?</BubbleContent>
                </Bubble>
              </MessageContent>
            </Message>
            <Message>
              <MessageAvatar>
                <AgentAvatar />
              </MessageAvatar>
              <MessageContent>
                <MessageHeader>
                  Clerk · agent · 2:02 PM
                </MessageHeader>
                <AgentRun
                  title="Handled invoice 120 in 14 s"
                  steps={[
                    { text: "Read invoice 120 · paid $0.01 by nanopayment" },
                    { text: "Vendor check on Lena · paid $0.02 · risk low" },
                    { text: "Name and address match saved payee Lena" },
                    { text: "Drafted proposal #5 on the treasury" },
                  ]}
                />
                <Bubble variant="ghost">
                  <BubbleContent>Drafted $2.40 to Lena for invoice 120. It needs one cosign.</BubbleContent>
                </Bubble>
                <CosignCard />
              </MessageContent>
            </Message>
            <Message align="end">
              <MessageContent>
                <MessageHeader>You · 2:04 PM</MessageHeader>
                <Bubble>
                  <BubbleContent>Looks right. Cosigning now.</BubbleContent>
                </Bubble>
              </MessageContent>
            </Message>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <StatusDot status="working" /> Auditor is reviewing proposal #5…
            </div>
          </MessageGroup>
        </div>
        <div className="border-t px-6 py-4">
          <div className="mx-auto max-w-3xl">
            <Composer placeholder="Message #invoices · @mention an agent to give it work" />
          </div>
        </div>
      </main>

      {/* agent panel */}
      <aside className="flex w-80 flex-col gap-4 border-l p-5">
        <div className="flex items-center gap-3">
          <AgentAvatar className="size-10" />
          <div>
            <div className="font-semibold">Clerk</div>
            <div className="text-xs text-muted-foreground">Accounts payable · team agent</div>
          </div>
          <Badge variant="outline" className="ml-auto">
            <StatusDot status="working" /> Working
          </Badge>
        </div>
        <Tabs defaultValue="wallet">
          <TabsList className="w-full">
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="wallet">Wallet</TabsTrigger>
            <TabsTrigger value="rules">Rules</TabsTrigger>
          </TabsList>
        </Tabs>
        <WalletSummary />
        <div className="grid gap-2 text-sm">
          <div className="flex items-center gap-2">
            <CalendarClock className="size-4 text-muted-foreground" /> Weekly vendor check · Mon 9:00
          </div>
          <div className="flex items-center gap-2">
            <Zap className="size-4 text-muted-foreground" /> Grok Bot: when an invoice arrives
          </div>
          <div className="flex items-center gap-2">
            <Cpu className="size-4 text-muted-foreground" /> Computer: asleep
          </div>
        </div>
        <Separator />
        <Button variant="outline">
          <AudioLines /> Talk to Clerk
        </Button>
      </aside>
    </div>
  );
}
