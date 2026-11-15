"use client";

/**
 * Design board (not in the nav): the call view, round two. The words are C's big caption with E's step line on top
 * (what the agent is doing, while you wait), shown working and then talking. Below it, four ways to approve a
 * payment the agent drafts during the call. Built from what the app already uses: the ElevenLabs Orb and Shimmering
 * Text, the chat's Trace, Pesto's Approval Row and Usdc, and shadcn Card, Item, Sheet and Button.
 */
import { useState } from "react";
import { Landmark } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { SectionHeader } from "@/components/section-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ShimmeringText } from "@/components/ui/shimmering-text";
import { Tag } from "@/components/ui/tag";
import { CallWords as SharedCallWords } from "../call-words";
import { AddressLine, LENA, Usdc } from "../money";
import { AgentOrb, ApprovalRow, Shell, Steps } from "../parts";

const HUE = "teal" as const;
const STEPS = ["Connecting to your wallet…", "Waiting for your signature…", "Sending your approval to the treasury on Arc…"];

/** C + E, the component the app uses: said as sentences here, so the newest one shimmers. */
function CallWords({ said, ...rest }: { asked: string; step: { title: string; lines: string[] }; said: string[]; running: boolean }) {
  return <SharedCallWords {...rest} said={said.join(" ")} live />;
}

function Panel({ letter, title, from, children, tall = false }: { letter: string; title: string; from: string; children: React.ReactNode; tall?: boolean }) {
  return (
    <Card className="overflow-hidden">
      <CardContent className={`flex ${tall ? "h-[680px]" : "h-[540px]"} flex-col gap-4`}>
        <div className="flex items-center gap-2">
          <span className="font-medium">
            {letter} · {title}
          </span>
          <Tag size="sm" variant="secondary">
            {from}
          </Tag>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5">{children}</div>
      </CardContent>
    </Card>
  );
}

const ASK_PAY = "Pay Lena for invoice 120.";
const PAY_STEP = { title: "Drafted proposal #14 · 3 steps", lines: ["Read invoice 120 · $2.40", "Lena's address matches the saved payee", "Drafted proposal #14 on the treasury"] };
const PAY_SAID = ["I drafted $2.40 to Lena for invoice 120.", "It needs your approval."];

export default function CallBoard() {
  const [sheet, setSheet] = useState(false);
  const [decided, setDecided] = useState<null | "approved" | "denied">(null);
  return (
    <Shell page="chat">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <PageHeader title="The call, round two" description="C's big caption with E's step line, then four ways to approve a payment during a call. Pick one of 1–4." />

        <SectionHeader title="The words: C + E" className="mt-6" />
        <div className="mt-3 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Panel letter="Working" title="while it checks" from="step open, its own words so far">
            <AgentOrb hue={HUE} state="thinking" className="size-32" />
            <CallWords
              asked="How much money is in my wallet?"
              running
              step={{ title: "Checking the wallet balances…", lines: ["Reading the agent wallet on Arc"] }}
              said={["One moment, I'll check the wallet balances now."]}
            />
          </Panel>
          <Panel letter="Talking" title="the answer streams in" from="step closes, words shimmer as said">
            <AgentOrb hue={HUE} state="talking" className="size-32" />
            <CallWords
              asked="How much money is in my wallet?"
              running={false}
              step={{ title: "Checked the wallet balances · 1 step", lines: ["Read the agent wallet and the treasury on Arc"] }}
              said={["Your wallet has $3.84 in USDC.", "The treasury has $1.50, and the weekly allowance is at zero."]}
            />
          </Panel>
        </div>

        <SectionHeader title="A payment during the call: pick one" className="mt-10" />
        <div className="mt-3 grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* 1: the chat's own approval row, under the words */}
          <Panel letter="1" title="Approval row" from="same as the chat" tall>
            <AgentOrb hue={HUE} state="listening" className="size-24" />
            <CallWords asked={ASK_PAY} running={false} step={PAY_STEP} said={PAY_SAID} />
            <div className="w-full max-w-md">
              <ApprovalRow
                title="Approve $2.40 to Lena?"
                description="Proposal #14 · you sign in your own wallet"
                address={{ value: LENA.address, label: "Lena's wallet address" }}
                approved={{ title: "Paid $2.40 to Lena", note: "Proposal #14 · approved by you" }}
                denied={{ title: "Denied", note: "Proposal #14 cancelled · nothing was paid" }}
                pending={STEPS}
              />
            </div>
          </Panel>

          {/* 2: the payment takes the stage: the amount large, who gets it, two big buttons; the words shrink above */}
          <Panel letter="2" title="Focus card" from="Card + Pesto Usdc" tall>
            <AgentOrb hue={HUE} state="listening" className="size-16" />
            <p className="max-w-md text-center text-lg font-light text-foreground/80">{PAY_SAID.join(" ")}</p>
            <Card className="w-full max-w-md">
              <CardContent className="flex flex-col items-center gap-4 text-center">
                <span className="text-sm text-muted-foreground">Proposal #14 · invoice 120</span>
                <Usdc amount={2.4} size="lg" />
                <div className="flex flex-col items-center gap-1">
                  <span className="font-medium">to {LENA.name}</span>
                  <AddressLine address={LENA.address} label="Lena's wallet address" />
                </div>
                {decided ? (
                  <p className="text-sm font-medium">{decided === "approved" ? "Approved · paying Lena" : "Denied · nothing was paid"}</p>
                ) : (
                  <div className="grid w-full grid-cols-2 gap-2">
                    <Button variant="outline" size="lg" onClick={() => setDecided("denied")}>
                      Deny
                    </Button>
                    <Button size="lg" onClick={() => setDecided("approved")}>
                      Approve
                    </Button>
                  </div>
                )}
                <span className="text-xs text-muted-foreground">You sign in your own wallet · the call keeps going</span>
              </CardContent>
            </Card>
          </Panel>

          {/* 3: a sheet slides up over the call; the orb and words stay behind it */}
          <Panel letter="3" title="Bottom sheet" from="shadcn Sheet" tall>
            <AgentOrb hue={HUE} state="listening" className="size-32" />
            <CallWords asked={ASK_PAY} running={false} step={PAY_STEP} said={PAY_SAID} />
            <Button variant="outline" onClick={() => setSheet(true)}>
              Show the sheet
            </Button>
            <Sheet open={sheet} onOpenChange={setSheet}>
              <SheetContent side="bottom" className="mx-auto max-w-xl rounded-t-2xl">
                <SheetHeader>
                  <SheetTitle>Approve $2.40 to Lena?</SheetTitle>
                  <SheetDescription>Proposal #14 · invoice 120 · you sign in your own wallet. Clerk stays on the call.</SheetDescription>
                </SheetHeader>
                <div className="flex items-center justify-between px-4">
                  <Usdc amount={2.4} size="md" />
                  <AddressLine address={LENA.address} label="Lena's wallet address" />
                </div>
                <SheetFooter className="grid grid-cols-2 gap-2">
                  <Button variant="outline" onClick={() => setSheet(false)}>
                    Deny
                  </Button>
                  <Button onClick={() => setSheet(false)}>Approve</Button>
                </SheetFooter>
              </SheetContent>
            </Sheet>
          </Panel>

          {/* 4: the payment is the last step of the step line, with its buttons on the row; nothing else moves */}
          <Panel letter="4" title="Step-line item" from="chat Trace + shadcn Item" tall>
            <AgentOrb hue={HUE} state="listening" className="size-32" />
            <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
              <p className="text-sm text-muted-foreground">You · {ASK_PAY}</p>
              <div className="w-full text-left">
                <Steps title={PAY_STEP.title} steps={PAY_STEP.lines} />
              </div>
              <Item variant="outline" className="w-full text-left">
                <ItemMedia variant="icon">
                  <Landmark />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>$2.40 to Lena · proposal #14</ItemTitle>
                  <ItemDescription>Needs your approval · you sign in your wallet</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button size="sm" variant="outline">
                    Deny
                  </Button>
                  <Button size="sm">Approve</Button>
                </ItemActions>
              </Item>
              <div className="text-2xl leading-relaxed font-light text-foreground/90">
                <ShimmeringText text={PAY_SAID.join(" ")} className="inline" duration={2.4} repeat />
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </Shell>
  );
}
