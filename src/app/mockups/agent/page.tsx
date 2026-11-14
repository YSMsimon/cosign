"use client";

import { AudioLines, Brain, CalendarClock, Cpu, MessageSquare, PanelLeft, Plus, Share, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Message, MessageContent, MessageGroup, MessageHeader } from "@/components/ui/message";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentAvatar, AgentRun, agents, Composer, CosignCard, StatusDot, WalletSummary } from "../parts";

const recent = ["What's waiting for a cosign?", "Invoice 120 from Lena", "Weekly vendor check", "Petty cash for API data"];

/** Option C: the agent workspace. One agent in focus, Grok-style composer with Talk, its computer and money on the right. */
export default function AgentWorkspace() {
  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-64 flex-col border-r bg-muted/30">
        <div className="flex items-center justify-between p-3">
          <Button size="icon" variant="ghost">
            <PanelLeft />
          </Button>
          <span className="text-sm font-semibold">Nova Labs</span>
          <Button size="icon" variant="ghost">
            <Plus />
          </Button>
        </div>
        <div className="px-4 pb-1 text-xs font-medium text-muted-foreground">Agents</div>
        <div className="grid gap-1 px-2">
          {agents.map((a) => (
            <Button key={a.id} variant={a.id === "clerk" ? "secondary" : "ghost"} className="h-auto justify-start py-2 font-normal">
              <AgentAvatar className="size-7" />
              <div className="grid text-left">
                <span className="text-sm">{a.name}</span>
                <span className="text-xs text-muted-foreground">{a.job}</span>
              </div>
              <span className="ml-auto">
                <StatusDot status={a.status} />
              </span>
            </Button>
          ))}
        </div>
        <div className="px-4 pt-5 pb-1 text-xs font-medium text-muted-foreground">Recent with Clerk</div>
        <div className="grid gap-0.5 px-2">
          {recent.map((r, i) => (
            <Button key={r} variant={i === 0 ? "secondary" : "ghost"} className="justify-start truncate font-normal">
              <MessageSquare className="text-muted-foreground" />
              <span className="truncate">{r}</span>
            </Button>
          ))}
        </div>
        <div className="mt-auto p-3 text-xs text-muted-foreground">2 payments wait for your cosign</div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-center gap-2 border-b py-3">
          <AgentAvatar className="size-6" />
          <span className="font-semibold">Clerk</span>
          <Badge variant="outline">Grok Bot connected</Badge>
          <Button size="sm" variant="ghost" className="absolute right-[21rem]">
            <Share /> Share
          </Button>
        </header>
        <div className="flex-1 overflow-auto px-6 py-6">
          <MessageGroup className="mx-auto max-w-2xl gap-6">
            <Message align="end">
              <MessageContent>
                <Bubble variant="secondary">
                  <BubbleContent>What&apos;s waiting for a cosign?</BubbleContent>
                </Bubble>
              </MessageContent>
            </Message>
            <Message>
              <MessageContent>
                <MessageHeader>
                  <span className="flex items-center gap-1.5">
                    <AudioLines className="size-3.5" /> said in a voice call · 0:42
                  </span>
                </MessageHeader>
                <AgentRun title="Checked the treasury" steps={[{ text: "list_proposals · 2 open" }, { text: "list_payees · Lena (contractor)" }]} />
                <Bubble variant="ghost">
                  <BubbleContent>
                    Two payments to Lena are waiting, both two dollars forty. Proposal five is for invoice 120 and passed every check.
                  </BubbleContent>
                </Bubble>
                <CosignCard compact />
              </MessageContent>
            </Message>
            <Message align="end">
              <MessageContent>
                <Bubble variant="secondary">
                  <BubbleContent>Run a fresh vendor check on Lena first.</BubbleContent>
                </Bubble>
              </MessageContent>
            </Message>
            <Message>
              <MessageContent>
                <AgentRun title="Running vendor check" steps={[{ text: "Paying $0.02 by nanopayment", status: "running" }]} />
              </MessageContent>
            </Message>
          </MessageGroup>
        </div>
        <div className="px-6 pb-6">
          <div className="mx-auto max-w-2xl">
            <Composer placeholder="Ask Clerk anything" grok />
          </div>
        </div>
      </main>

      <aside className="flex w-80 flex-col gap-4 border-l p-5">
        <div className="flex flex-col items-center gap-2 pt-2">
          <AgentAvatar className="size-16" />
          <div className="text-lg font-semibold">Clerk</div>
          <div className="text-xs text-muted-foreground">Accounts payable · works in its own computer</div>
        </div>
        <Tabs defaultValue="activity">
          <TabsList className="w-full">
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="memory">Memory</TabsTrigger>
            <TabsTrigger value="rules">Rules</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="grid gap-2">
          <div className="text-xs font-medium text-muted-foreground">Upcoming</div>
          <div className="flex items-center gap-2 rounded-lg border p-3 text-sm">
            <Zap className="size-4 text-muted-foreground" />
            <div className="grid">
              <span>When an invoice arrives</span>
              <span className="text-xs text-muted-foreground">Grok Bot webhook</span>
            </div>
            <Switch defaultChecked className="ml-auto" />
          </div>
          <div className="flex items-center gap-2 rounded-lg border p-3 text-sm">
            <CalendarClock className="size-4 text-muted-foreground" />
            <div className="grid">
              <span>Weekly vendor check</span>
              <span className="text-xs text-muted-foreground">Mondays 9:00</span>
            </div>
            <Switch defaultChecked className="ml-auto" />
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg border p-3 text-sm">
          <Cpu className="size-4 text-muted-foreground" /> Clerk&apos;s computer
          <span className="ml-auto text-xs text-muted-foreground">Asleep</span>
        </div>
        <div className="flex items-center gap-2 rounded-lg border p-3 text-sm">
          <Brain className="size-4 text-muted-foreground" /> Memory
          <span className="ml-auto text-xs text-muted-foreground">5 notes</span>
        </div>
        <Separator />
        <WalletSummary />
      </aside>
    </div>
  );
}
