"use client";

import { Orb, type AgentState } from "@/components/ui/orb";
import { PageHeader } from "@/components/page-header";
import { SectionHeader } from "@/components/section-header";
import { AgentOrb, HUE_COLORS, Shell } from "../parts";

const STATES: { label: string; state: AgentState }[] = [
  { label: "Idle", state: null },
  { label: "Connecting / thinking", state: "thinking" },
  { label: "Listening", state: "listening" },
  { label: "Talking", state: "talking" },
];

/** Design board (not in the nav): the agent orb, idle to talking, next to the plain ElevenLabs Orb. */
export default function OrbsBoard() {
  return (
    <Shell page="team">
      <div className="mx-auto max-w-5xl px-8 py-8">
        <PageHeader title="Orbs" description="One orb per agent, from the list to the call. Only its state changes." />

        <div className="mt-8">
          <SectionHeader title="Agent orb (Pesto disc + ElevenLabs Orb)" description="Pesto disc, with the ElevenLabs Orb (hue mixed with 65% white) multiplied on top. Nothing turns; the shapes change inside." />
          <div className="mt-4 grid grid-cols-4 gap-6">
            {STATES.map((s) => (
              <div key={s.label} className="flex flex-col items-center gap-3">
                <AgentOrb hue="blue" state={s.state} className="size-40" />
                <span className="text-xs text-muted-foreground">{s.label}</span>
              </div>
            ))}
          </div>
          <div className="mt-6 flex items-center gap-4">
            {(["violet", "pink", "orange", "blue", "teal"] as const).map((h) => (
              <AgentOrb key={h} hue={h} className="size-8" />
            ))}
            <span className="text-xs text-muted-foreground">idle at list size</span>
          </div>
        </div>

        <div className="mt-12">
          <SectionHeader title="Before: plain ElevenLabs Orb in the full hue colours" description="For comparison. Strong colours on white make a hard pinwheel; the agent orb above uses pale tints on the Pesto disc." />
          <div className="mt-4 grid grid-cols-4 gap-6">
            {STATES.filter((s) => s.state === null || s.state === "talking").map((s) => (
              <div key={s.label} className="flex flex-col items-center gap-3">
                <div className="size-40 overflow-hidden rounded-full">
                  <Orb colors={HUE_COLORS.blue} seed={4000} agentState={s.state} />
                </div>
                <span className="text-xs text-muted-foreground">{s.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Shell>
  );
}
