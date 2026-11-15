"use client";

/**
 * Agents, not sessions: each agent is one conversation that keeps going. You create an agent (and pick its
 * orb colour once, like a Grok agent) or delete it; there is nothing else to create or delete. The orbs are the
 * ElevenLabs Orb, idle, in the agent's colours; the rows are Pesto's UserRow, the colour choice Pesto's
 * ToggleGroup, the menus and dialogs Pesto's DropdownMenu and Dialog.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { EllipsisVertical, Settings2, Trash2 } from "lucide-react";
import type { OrbHue } from "@/components/orb-avatar";
import { UserRow } from "@/components/user-row";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeaderText,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { AgentOrb } from "./parts";

export type Agent = { id: string; name: string; hue: OrbHue; job: string; online: boolean; now: string };

export const HUES: OrbHue[] = ["violet", "pink", "orange", "blue", "teal"];
const hueName = (h: OrbHue) => h.charAt(0).toUpperCase() + h.slice(1);

/** The five orb colours (idle ElevenLabs orbs) as a single-choice ToggleGroup. Chosen once, when the agent is created. */
export function HuePicker({ value, onChange }: { value: OrbHue; onChange: (hue: OrbHue) => void }) {
  return (
    <ToggleGroup type="single" variant="outline" value={value} onValueChange={(v) => v && onChange(v as OrbHue)} aria-label="Orb colour">
      {HUES.map((h) => (
        <ToggleGroupItem key={h} value={h} aria-label={hueName(h)} className="px-2">
          <AgentOrb hue={h} still className="size-6" />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** Create an agent: a name, what it does, and its orb colour. Spending is set on the Permissions page. */
export function NewAgentDialog({
  trigger,
  onCreate,
  open,
  onOpenChange,
}: {
  trigger?: React.ReactNode;
  onCreate?: (a: Agent) => void;
  /** set these to open it from somewhere else, e.g. the sidebar's + menu */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [hue, setHue] = useState<OrbHue>("orange");
  const [name, setName] = useState("");
  const [job, setJob] = useState("");
  const create = () => {
    if (!name.trim()) return;
    onCreate?.({ id: `agent-${Date.now()}`, name: name.trim(), hue, job: job.trim() || "New agent", online: false, now: "Not started yet" });
    setName("");
    setJob("");
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent>
        <DialogHeader>
          <DialogHeaderText>
            <DialogTitle>New agent</DialogTitle>
            <DialogDescription>An agent is one conversation that keeps going. You set what it may spend on the Permissions page.</DialogDescription>
          </DialogHeaderText>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-5">
          <UserRow variant="card" avatar={<AgentOrb hue={hue} className="size-10" />} label={name.trim() || "Your new agent"} sublabel={job.trim() || "What it does"} />
          <div className="grid gap-2">
            <Label htmlFor="new-agent-name">Name</Label>
            <Input id="new-agent-name" placeholder="Payroll" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-agent-job">What it does</Label>
            <Textarea id="new-agent-job" rows={3} placeholder="Pays the contractors every Friday" value={job} onChange={(e) => setJob(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Colour</Label>
            <HuePicker value={hue} onChange={setHue} />
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <DialogClose asChild>
            <Button disabled={!name.trim()} onClick={create}>
              Create agent
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The three-dot menu on an agent row: configure it, or delete it (after a confirm). Its colour is set at creation. */
export function AgentMenu({ agent, onDelete }: { agent: Agent; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const board = usePathname().startsWith("/mockups");
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Options for ${agent.name}`}>
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={board ? "/mockups/v2/permissions" : `/permissions?agent=${agent.id}`}>
              <Settings2 /> Configure
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            <Trash2 /> Delete agent
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogHeaderText>
              <DialogTitle>Delete {agent.name}?</DialogTitle>
              <DialogDescription>It stops working right away. Its payments and drafts stay on the record.</DialogDescription>
            </DialogHeaderText>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button variant="destructive" onClick={onDelete}>
                Delete agent
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The agents, one row each: orb on the left, name and what it is doing, the three-dot menu on the right. */
export function AgentList({
  agents,
  selected,
  onSelect,
  onDelete,
}: {
  agents: Agent[];
  selected: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {agents.map((a) => (
        <UserRow
          key={a.id}
          variant={a.id === selected ? "card" : "plain"}
          className={cn("cursor-pointer rounded-xl", a.id !== selected && "border border-transparent p-3 hover:bg-accent")}
          onClick={() => onSelect(a.id)}
          avatar={<AgentOrb hue={a.hue} className="size-8" />}
          label={a.name}
          sublabel={a.online ? `Working · ${a.now}` : a.job}
          action={
            /* the row selects the agent; clicks in the menu and its dialogs (portals bubble through React) stay here */
            <span onClick={(e) => e.stopPropagation()}>
              <AgentMenu agent={a} onDelete={() => onDelete(a.id)} />
            </span>
          }
        />
      ))}
    </div>
  );
}
