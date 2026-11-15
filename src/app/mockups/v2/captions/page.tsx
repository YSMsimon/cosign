"use client";

/**
 * Design board (not in the nav): the words under the orb during a call, five ways. The same moment each time: you
 * asked Clerk about the money, it checked and is answering. Built from what the app already uses: the ElevenLabs
 * Orb, Shimmering Text and Matrix, and the chat's Message, Trace and Card. B to E follow ElevenLabs UI's own blocks.
 */
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Matrix } from "@/components/ui/matrix";
import { ShimmeringText } from "@/components/ui/shimmering-text";
import { Tag } from "@/components/ui/tag";
import { AgentOrb, HUE_COLORS, Shell, Steps } from "../parts";
import { AgentSaid, Words, YouSaid } from "../thread";

const ASKED = "How much money is in my wallet?";
const SAID = ["One moment, I'll check the wallet balances now.", "Your wallet has $3.84 in USDC.", "The treasury has $1.50, and the weekly allowance is at zero."];
const HUE = "teal" as const;

/** A voice level that moves (sample), for the Matrix meter. */
function useLevels() {
  const [levels, setLevels] = useState<number[]>(() => Array.from({ length: 20 }, () => 0.2));
  useEffect(() => {
    const t = setInterval(() => setLevels(Array.from({ length: 20 }, (_, i) => 0.25 + 0.6 * Math.abs(Math.sin(Date.now() / 260 + i * 0.7)) * Math.random())), 120);
    return () => clearInterval(t);
  }, []);
  return levels;
}

function Meter({ levels, cols = 20 }: { levels: number[]; cols?: number }) {
  return <Matrix rows={7} cols={cols} mode="vu" levels={levels.slice(0, cols)} size={6} gap={3} palette={{ on: HUE_COLORS[HUE][0], off: "rgba(120,120,120,0.15)" }} ariaLabel="Voice level" />;
}

function Option({ letter, title, from, children }: { letter: string; title: string; from: string; children: React.ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="flex h-[560px] flex-col gap-4">
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

export default function CaptionsBoard() {
  const levels = useLevels();
  return (
    <Shell page="chat">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <PageHeader title="Words during a call" description="What shows under the orb while the agent talks. Pick one; it replaces the plain line in every call." />
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* today: one plain paragraph */}
          <Option letter="A" title="Today" from="plain text">
            <AgentOrb hue={HUE} state="talking" className="size-36" />
            <ShimmeringText text="Talking" className="text-lg font-medium" repeat />
            <Meter levels={levels} />
            <p className="max-w-md text-center text-sm text-muted-foreground">{SAID.join(" ")}</p>
          </Option>

          {/* B: the call as a short transcript, like the chat (ElevenLabs voice-chat-01 / 03) */}
          <Option letter="B" title="Transcript" from="ElevenLabs voice chat 01 / 03">
            <AgentOrb hue={HUE} state="talking" className="size-24 shrink-0" />
            <ShimmeringText text="Talking" className="text-sm font-medium" repeat />
            <div className="flex w-full max-w-md min-h-0 flex-1 flex-col justify-end gap-4 overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_30%)]">
              <YouSaid line={{ who: "you", text: ASKED }} />
              <AgentSaid name="Clerk" hue={HUE}>
                <Words>{SAID.join(" ")}</Words>
              </AgentSaid>
            </div>
          </Option>

          {/* C: the words large and light, the newest one shimmering as it is said (ElevenLabs realtime transcriber 01) */}
          <Option letter="C" title="Big caption" from="ElevenLabs realtime transcriber 01">
            <AgentOrb hue={HUE} state="talking" className="size-32" />
            <p className="text-sm text-muted-foreground">You · {ASKED}</p>
            <div className="max-w-md text-center text-2xl leading-relaxed font-light text-foreground/90">
              <span className="text-foreground/50">{SAID.slice(0, 2).join(" ")} </span>
              <ShimmeringText text={SAID[2]} className="inline" duration={2.4} repeat />
            </div>
          </Option>

          {/* D: the orb in an inset well, the words on a card with who is talking and the voice level (ElevenLabs voice chat 02) */}
          <Option letter="D" title="Caption card" from="ElevenLabs voice chat 02">
            <div className="relative size-36">
              <div className="h-full w-full rounded-full bg-muted p-1 shadow-[inset_0_2px_8px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_2px_8px_rgba(0,0,0,0.5)]">
                <div className="h-full w-full overflow-hidden rounded-full bg-background shadow-[inset_0_0_12px_rgba(0,0,0,0.05)]">
                  <AgentOrb hue={HUE} state="talking" className="size-full" />
                </div>
              </div>
            </div>
            <Card className="w-full max-w-md" size="sm">
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-center gap-2 text-sm">
                  <AgentOrb hue={HUE} className="size-5" />
                  <span className="font-medium">Clerk</span>
                  <ShimmeringText text="talking" className="text-xs text-muted-foreground" repeat />
                </div>
                <p className="leading-7">{SAID.slice(1).join(" ")}</p>
                <Meter levels={levels} cols={28} />
              </CardContent>
            </Card>
          </Option>

          {/* E: what the agent is doing (the chat's Trace line), then its words */}
          <Option letter="E" title="Step and words" from="chat Trace + ElevenLabs Matrix">
            <AgentOrb hue={HUE} state="talking" className="size-32" />
            <Meter levels={levels} />
            <div className="flex w-full max-w-md flex-col gap-2">
              <Steps title="Checked the wallet balances · 1 step" steps={["Read the agent wallet and the treasury on Arc"]} />
              <Words>{SAID.slice(1).join(" ")}</Words>
            </div>
          </Option>
        </div>
      </div>
    </Shell>
  );
}
