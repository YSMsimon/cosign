"use client";

import { FileTextIcon } from "lucide-react";
import { Attachment, AttachmentContent, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "@/components/ui/attachment";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Tag } from "@/components/ui/tag";
import type { OrbHue } from "@/components/orb-avatar";
import { BrandFace, GROK_BOT } from "./mentions";
import { AgentOrb } from "./parts";
import type { Line } from "./store";

function Files({ files }: { files?: string[] }) {
  if (!files?.length) return null;
  return (
    <AttachmentGroup>
      {files.map((f) => (
        <Attachment key={f} size="sm">
          <AttachmentMedia>
            <FileTextIcon />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{f}</AttachmentTitle>
          </AttachmentContent>
        </Attachment>
      ))}
    </AttachmentGroup>
  );
}

/** Your turn: shadcn AI Elements' muted bubble on the right, with any files and a Voice label. */
export function YouSaid({ line, children }: { line: Line; children?: React.ReactNode }) {
  return (
    <Message align="end">
      <MessageContent>
        {line.via === "voice" && (
          <MessageHeader>
            <Tag variant="info">Voice</Tag>
          </MessageHeader>
        )}
        <Files files={line.files} />
        {line.text && (
          <Bubble align="end" variant="muted">
            <BubbleContent className={children ? "leading-7" : undefined}>{children ?? line.text}</BubbleContent>
          </Bubble>
        )}
      </MessageContent>
    </Message>
  );
}

/**
 * The words of a message: shadcn Bubble, ghost variant (no fill, no padding). Message drops its header's bubble
 * indent when a ghost bubble is inside, so the name lines up with the text; the taller line fits inline tags.
 */
export function Words({ children }: { children: React.ReactNode }) {
  return (
    <Bubble variant="ghost">
      <BubbleContent className="leading-7">{children}</BubbleContent>
    </Bubble>
  );
}

/* Team-chat layout on shadcn Message: the face at the top beside the name (Message puts it at the bottom, for bubbles). */
const ROW = "gap-3";
const FACE = "self-start";
const NAME = "px-0 text-sm font-medium text-foreground";

/** A teammate's turn in a room: their initials, their name, what they said. */
export function PersonSaid({ name, initials, line, children }: { name: string; initials: string; line: Line; children?: React.ReactNode }) {
  return (
    <Message className={ROW}>
      <MessageAvatar className={FACE}>
        <Avatar>
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
      </MessageAvatar>
      <MessageContent className="gap-1">
        <MessageHeader className={NAME}>{name}</MessageHeader>
        <Files files={line.files} />
        {(children || line.text) && <Words>{children ?? line.text}</Words>}
      </MessageContent>
    </Message>
  );
}

/** An agent's turn in a room: its orb and name over whatever it shows (steps, words, an approval). */
export function AgentSaid({ name, hue, thinking = false, tag, face, children }: { name: string; hue: OrbHue; thinking?: boolean; tag?: React.ReactNode; face?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Message className={ROW}>
      {/* a product icon keeps its own rounded square; MessageAvatar would clip it to a circle */}
      <MessageAvatar className={face ? `${FACE} rounded-[22%] bg-transparent` : FACE}>
        {face ?? (thinking ? <AgentOrb hue={hue} state="thinking" className="size-8" /> : <AgentOrb hue={hue} still className="size-8" />)}
      </MessageAvatar>
      <MessageContent className="gap-2">
        <MessageHeader className={`${NAME} gap-1.5`}>
          {name}
          {tag}
        </MessageHeader>
        {children}
      </MessageContent>
    </Message>
  );
}

/** Grok Bot's turn: the same agent row with its own app icon, tagged so everyone sees it ran in the background. */
export function GrokSaid({ children }: { children: React.ReactNode }) {
  return (
    <AgentSaid name={GROK_BOT.name} hue="orange" face={<BrandFace src={GROK_BOT.image!} name={GROK_BOT.name} className="size-8" />} tag={<Tag size="sm" variant="secondary">{GROK_BOT.badge}</Tag>}>
      {children}
    </AgentSaid>
  );
}

/** A line from Cosign itself between messages, e.g. "Friday 9:00 · Grok Bot started the run" (shadcn Marker). */
export function ChainEvent({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <Marker variant="separator">
      <MarkerIcon>{icon}</MarkerIcon>
      <MarkerContent>{children}</MarkerContent>
    </Marker>
  );
}
