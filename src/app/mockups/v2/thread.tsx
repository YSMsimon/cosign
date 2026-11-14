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
            <BubbleContent>{children ?? line.text}</BubbleContent>
          </Bubble>
        )}
      </MessageContent>
    </Message>
  );
}

/** A teammate's turn in a room: their initials, their name, what they said. */
export function PersonSaid({ name, initials, line, children }: { name: string; initials: string; line: Line; children?: React.ReactNode }) {
  return (
    <Message>
      <MessageAvatar>
        <Avatar>
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
      </MessageAvatar>
      <MessageContent>
        <MessageHeader className="text-sm font-medium">{name}</MessageHeader>
        <Files files={line.files} />
        {/* a div, not a p: mention tags hold an orb (a div) */}
        {children ? <div>{children}</div> : line.text && <p>{line.text}</p>}
      </MessageContent>
    </Message>
  );
}

/** An agent's turn in a room: its orb and name over whatever it shows (steps, text, an approval). */
export function AgentSaid({ name, hue, thinking = false, children }: { name: string; hue: OrbHue; thinking?: boolean; children: React.ReactNode }) {
  return (
    <Message>
      <MessageAvatar>
        {thinking ? <AgentOrb hue={hue} state="thinking" className="size-8" /> : <AgentOrb hue={hue} still className="size-8" />}
      </MessageAvatar>
      <MessageContent className="gap-3">
        <MessageHeader className="text-sm font-medium">{name}</MessageHeader>
        {children}
      </MessageContent>
    </Message>
  );
}
