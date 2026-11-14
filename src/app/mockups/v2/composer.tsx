"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpIcon, AudioLines, FileTextIcon, Mic, PlusIcon, XIcon } from "lucide-react";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentMedia, AttachmentTitle } from "@/components/ui/attachment";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Mention, MentionContent, MentionInput, MentionItem } from "@/components/ui/mention";
import { Tag } from "@/components/ui/tag";
import { cn } from "@/lib/utils";
import { MemberFace, mentionedIn, type Member } from "./mentions";

export type Picked = { id: string; name: string; url?: string };

/** Files from the picker or a drop, with a local preview for images. */
export const toPicked = (list: FileList): Picked[] =>
  Array.from(list, (f) => ({ id: crypto.randomUUID(), name: f.name, url: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined }));

/**
 * The message box: shadcn AI Elements Prompt Input (Input Group + Attachment). + opens the file picker; files can
 * also be dropped anywhere on the page, so the parent owns `files`. On the right, Send once there is something to
 * send; otherwise Talk when the conversation has a voice (`onTalk`).
 *
 * In a room, `mentions` lists who @ can name: typing @ opens Dice UI Mention at the caret (Simon's pick), and
 * whoever is @named shows as a Pesto Tag with their face next to +, so you can see who you are asking.
 */
export function Composer({
  placeholder,
  files,
  setFiles,
  onSend,
  onTalk,
  busy = false,
  mentions,
}: {
  placeholder: string;
  files: Picked[];
  setFiles: (update: (cur: Picked[]) => Picked[]) => void;
  onSend: (text: string, files: Picked[]) => void;
  onTalk?: () => void;
  busy?: boolean;
  mentions?: Member[];
}) {
  const [draft, setDraft] = useState("");
  const [listOpen, setListOpen] = useState(false);
  /* Dice keeps its own list of where each mention sits and only updates it on its own edits. After we clear the box
     it would still hold the old positions and paint the next mentions twice, so each send starts a fresh Mention.
     Dice also misplaces mentions when one is added before another; the check below catches that too. */
  const [round, setRound] = useState(0);
  const caretAfterReset = useRef<number | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const canSend = (draft.trim().length > 0 || files.length > 0) && !busy;
  const named = mentions ? mentionedIn(draft, mentions) : [];

  const startFresh = (caret: number) => {
    caretAfterReset.current = caret;
    setRound((r) => r + 1);
  };

  // if Dice's painted copy of the text (its highlight layer) no longer matches the text, start it fresh
  useEffect(() => {
    if (!mentions) return;
    const id = requestAnimationFrame(() => {
      const box = formRef.current?.querySelector("textarea");
      const layer = box?.parentElement?.firstElementChild;
      if (!box || !layer || layer === box) return;
      const painted = (layer.textContent ?? "").slice(0, -1); // Dice adds one trailing space
      if (painted !== draft) startFresh(box.selectionStart);
    });
    return () => cancelAnimationFrame(id);
  }, [draft, mentions]);

  // the fresh Mention brings a new textarea; put the caret back and keep typing in it
  useEffect(() => {
    const caret = caretAfterReset.current;
    if (caret === null) return;
    caretAfterReset.current = null;
    requestAnimationFrame(() => {
      const box = formRef.current?.querySelector("textarea");
      box?.focus();
      box?.setSelectionRange(caret, caret);
    });
  }, [round]);

  const textarea = (
    <InputGroupTextarea
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      placeholder={placeholder}
      aria-label="Message"
      className="min-h-14 px-5 pt-3.5"
      onKeyDown={(e) => {
        // while the @ list is open, Enter picks a name (Dice handles it) instead of sending
        if (e.key === "Enter" && !e.shiftKey && !listOpen) {
          e.preventDefault();
          formRef.current?.requestSubmit();
        }
      }}
    />
  );

  const box = (
    /* Dice's Mention wraps the textarea in an unstyled div; stretch that div so the text box spans the row */
    <InputGroup className={cn("rounded-3xl", mentions && "[&>div:has(>textarea)]:w-full")}>
      {files.length > 0 && (
        <InputGroupAddon align="block-start" className="flex-wrap px-3.5 pt-3.5">
          {files.map((f) => (
            <Attachment key={f.id} size="sm">
              <AttachmentMedia>
                {/* eslint-disable-next-line @next/next/no-img-element -- a local preview of a picked file */}
                {f.url ? <img src={f.url} alt="" /> : <FileTextIcon />}
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{f.name}</AttachmentTitle>
              </AttachmentContent>
              <AttachmentActions>
                <AttachmentAction aria-label={`Remove ${f.name}`} onClick={() => setFiles((cur) => cur.filter((x) => x.id !== f.id))}>
                  <XIcon />
                </AttachmentAction>
              </AttachmentActions>
            </Attachment>
          ))}
        </InputGroupAddon>
      )}
      {mentions ? (
        /* Dice's input brings its own box (border, radius, padding); these props hand that back to Input Group */
        <MentionInput asChild className="min-h-14 w-full rounded-none border-0 bg-transparent px-5 pt-3.5 focus-visible:ring-0">
          {textarea}
        </MentionInput>
      ) : (
        textarea
      )}
      <InputGroupAddon align="block-end" className="px-3.5 pt-1 pb-3.5">
        {/* + opens the computer's file picker straight away */}
        <InputGroupButton
          aria-label="Add photos & files"
          type="button"
          size="icon-sm"
          variant="outline"
          className="rounded-full"
          onClick={() => fileRef.current?.click()}
        >
          <PlusIcon />
        </InputGroupButton>
        {/* who this message @names, with their faces (Backspace in the text removes a mention whole) */}
        {named.map((m) => (
          <Tag key={m.id} variant="info" size="sm" appear leading={<MemberFace m={m} className="size-4" />}>
            {m.name}
          </Tag>
        ))}
        <div className="ml-auto flex items-center gap-1">
          <InputGroupButton type="button" size="icon-sm" variant="ghost" aria-label="Dictate">
            <Mic />
          </InputGroupButton>
          {canSend || !onTalk ? (
            /* aria-disabled, not disabled: Input Group greys the whole box when anything inside it is :disabled */
            <InputGroupButton
              type="submit"
              size="icon-sm"
              variant="default"
              className="rounded-full aria-disabled:opacity-50"
              aria-label="Send"
              aria-disabled={!canSend}
            >
              <ArrowUpIcon />
            </InputGroupButton>
          ) : (
            <InputGroupButton type="button" size="icon-sm" variant="default" className="rounded-full" aria-label="Talk" onClick={onTalk}>
              <AudioLines />
            </InputGroupButton>
          )}
        </div>
      </InputGroupAddon>
    </InputGroup>
  );

  return (
    <form
      ref={formRef}
      className="mx-auto w-full max-w-2xl"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSend) return;
        onSend(draft.trim(), files);
        setDraft("");
        setFiles(() => []);
        if (mentions) startFresh(0);
      }}
    >
      <input
        ref={fileRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const list = e.target.files;
          if (list?.length) setFiles((cur) => [...cur, ...toPicked(list)]);
          e.target.value = "";
        }}
      />
      {mentions ? (
        /* Dice UI Mention: watches for @, lists who can be named at the caret, inserts the name; the highlight matches the Tag */
        <Mention
          key={round}
          trigger="@"
          inputValue={draft}
          onInputValueChange={setDraft}
          onOpenChange={setListOpen}
          className="w-full **:data-tag:bg-info/15 **:data-tag:text-info"
        >
          {box}
          {/* above the caret: the box sits at the bottom of the page */}
          <MentionContent side="top" sideOffset={8} className="w-72">
            {mentions.map((m) => (
              <MentionItem key={m.id} value={m.name} className="gap-2 py-1.5">
                <MemberFace m={m} />
                <span className="font-medium">{m.name}</span>
                <span className="ml-auto truncate text-xs text-muted-foreground">{m.kind === "agent" ? "Agent" : m.sub.split(" · ")[0]}</span>
              </MentionItem>
            ))}
          </MentionContent>
        </Mention>
      ) : (
        box
      )}
    </form>
  );
}
