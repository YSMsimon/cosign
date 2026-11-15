"use client";

/**
 * The words under the orb in a call (picked by Simon, 2026-11-15: C's big caption with E's step line). What you said,
 * small; the step the agent is on (the chat's Trace line, open while it works); then its words large and light,
 * earlier sentences dimmed and the one being said shimmering (ElevenLabs Shimmering Text).
 */
import { ShimmeringText } from "@/components/ui/shimmering-text";
import { Steps } from "./parts";

/** Split spoken text into sentences, keeping each one's end mark. */
export const sentencesOf = (text: string) => text.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);

export function CallWords({
  asked,
  step,
  said,
  running,
  live,
}: {
  asked?: string | null;
  /** the step line: its title and the steps under it */
  step?: { title: string; lines: string[] } | null;
  said?: string | null;
  /** the agent is working: the step line is open and its icon turns */
  running: boolean;
  /** the agent is talking: the newest sentence shimmers */
  live: boolean;
}) {
  const all = sentencesOf(said ?? "");
  const [settled, newest] = live ? [all.slice(0, -1), all.at(-1)] : [all, undefined];
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
      {asked && <p className="text-sm text-muted-foreground">You · {asked}</p>}
      {step && (
        <div className="text-left">
          <Steps key={running ? "run" : "done"} running={running} open={running} title={step.title} steps={step.lines} />
        </div>
      )}
      {(settled.length > 0 || newest) && (
        <div className="text-2xl leading-relaxed font-light text-foreground/90" aria-live="polite">
          {settled.length > 0 && <span className={newest ? "text-foreground/50" : undefined}>{settled.join(" ")} </span>}
          {newest && <ShimmeringText text={newest} className="inline" duration={2.4} repeat />}
        </div>
      )}
    </div>
  );
}
