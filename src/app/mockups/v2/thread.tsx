"use client";

import { FileTextIcon } from "lucide-react";
import { Attachment, AttachmentContent, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "@/components/ui/attachment";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import { Tag } from "@/components/ui/tag";
import type { OrbHue } from "@/components/orb-avatar";
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
export function AgentSaid({ name, hue, thinking = false, children }: { name: string; hue: OrbHue; thinking?: boolean; children: React.ReactNode }) {
  return (
    <Message className={ROW}>
      <MessageAvatar className={FACE}>
        {thinking ? <AgentOrb hue={hue} state="thinking" className="size-8" /> : <AgentOrb hue={hue} still className="size-8" />}
      </MessageAvatar>
      <MessageContent className="gap-2">
        <MessageHeader className={NAME}>{name}</MessageHeader>
        {children}
      </MessageContent>
    </Message>
  );
}
