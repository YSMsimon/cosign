"use client";

import "@xyflow/react/dist/style.css";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { Landmark, Store, User, Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { AddressLine } from "../money";
import { AgentOrb } from "../parts";
import { clerk, treasury, usd } from "./mock";

type Box = { title: string; sub: string; face: React.ReactNode; lines?: string[]; tag?: string; addresses?: { name: string; address: string }[] };

/** One place money can be: a shadcn Card as a React Flow node (shadcn's own advice for workflows). */
function BoxNode({ data }: NodeProps<Node<Box>>) {
  return (
    <Card className="w-60 gap-2 py-3">
      <Handle id="l" type="target" position={Position.Left} className="opacity-0" />
      <Handle id="t" type="target" position={Position.Top} className="opacity-0" />
      <Handle id="bi" type="target" position={Position.Bottom} className="opacity-0" />
      <CardHeader className="flex flex-row items-center gap-2.5 px-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary [&_svg]:size-4">{data.face}</span>
        <div className="flex min-w-0 flex-col">
          <CardTitle className="text-sm">{data.title}</CardTitle>
          <CardDescription className="truncate text-xs">{data.sub}</CardDescription>
        </div>
      </CardHeader>
      {(data.lines?.length || data.tag || data.addresses?.length) && (
        <CardContent className="flex flex-col gap-1 px-3 text-xs text-muted-foreground">
          {data.lines?.map((l) => (
            <span key={l}>{l}</span>
          ))}
          {data.addresses?.map((a) => (
            <span key={a.address} className="flex items-center gap-1">
              {a.name && <span>{a.name}</span>}
              <AddressLine address={a.address} label={`${a.name || data.title}'s address`} className="nodrag" />
            </span>
          ))}
          {data.tag && (
            <Tag size="sm" variant="success" className="self-start">
              {data.tag}
            </Tag>
          )}
        </CardContent>
      )}
      <Handle id="r" type="source" position={Position.Right} className="opacity-0" />
      <Handle id="b" type="source" position={Position.Bottom} className="opacity-0" />
      <Handle id="lo" type="source" position={Position.Left} className="opacity-0" />
    </Card>
  );
}

const c = clerk.controls;
const nodes: Node<Box>[] = [
  {
    id: "clerk",
    type: "box",
    position: { x: 0, y: 0 },
    data: { title: "Clerk", sub: `Agent wallet · ${usd(clerk.walletUsdc)} USDC`, face: <AgentOrb hue="blue" still className="size-8" />, lines: ["Pays for APIs, drafts payments, petty cash"], addresses: [{ name: "", address: clerk.wallet }] },
  },
  {
    id: "checks",
    type: "box",
    position: { x: 370, y: 0 },
    data: {
      title: "Company rules",
      sub: "Our server checks before signing",
      face: <Users />,
      lines: [`Per payment ${usd(c.purchases.perPayment)} · ${usd(c.drafts.perPayment)}`, `Per day ${usd(c.purchases.daily)} · ${usd(c.drafts.daily)}`, `${c.maxPaymentsPerHour} a hour · ask above ${usd(c.askAboveUsd)}`],
    },
  },
  {
    id: "apis",
    type: "box",
    position: { x: 740, y: 0 },
    data: { title: "Paid APIs", sub: "Nanopayments (x402)", face: <Store />, lines: c.allowedSellers },
  },
  {
    id: "treasury",
    type: "box",
    position: { x: 370, y: 230 },
    data: { title: "Treasury", sub: `${treasury.chain} · ${usd(treasury.balanceUsd)} USDC`, face: <Landmark />, tag: "Contract enforces this", addresses: [{ name: "", address: treasury.address }] },
  },
  {
    id: "approvers",
    type: "box",
    position: { x: 740, y: 230 },
    data: { title: "Approvers", sub: `${treasury.threshold} of ${treasury.approvers.length} must sign`, face: <Users />, addresses: treasury.approvers.map((a) => ({ name: a.name, address: a.wallet })) },
  },
  {
    id: "payee",
    type: "box",
    position: { x: 740, y: 420 },
    data: { title: "Lena", sub: "Saved payee", face: <User />, addresses: [{ name: "", address: c.allowedPayees[0].address }] },
  },
];

const edge = (id: string, source: string, target: string, label: string, extra: Partial<Edge> = {}): Edge => ({
  id,
  source,
  target,
  label,
  markerEnd: { type: MarkerType.ArrowClosed },
  labelBgPadding: [6, 3],
  labelBgBorderRadius: 6,
  ...extra,
});

const across = { sourceHandle: "r", targetHandle: "l" };
const down = { sourceHandle: "b", targetHandle: "t" };
const edges: Edge[] = [
  edge("e1", "clerk", "checks", "every payment", { ...across, animated: true }),
  edge("e2", "checks", "apis", `purchases ≤ ${usd(c.purchases.perPayment)}`, across),
  edge("e3", "checks", "treasury", `drafts ≤ ${usd(c.drafts.perPayment)}`, { ...down, animated: true }),
  edge("e4", "treasury", "approvers", "waits for signatures", { ...across, animated: true }),
  edge("e5", "approvers", "payee", "paid when approved", { ...down, animated: true }),
  edge("e6", "treasury", "clerk", `petty cash ≤ ${usd(c.pettyCashPerWeekUsd)}/week`, { sourceHandle: "lo", targetHandle: "bi", style: { strokeDasharray: "6 4" } }),
];

/** D. Money map: where money can move and which rule guards each path. Pan, zoom, drag the cards. */
export function MoneyMap() {
  return (
    <div className="h-[560px] overflow-hidden rounded-2xl border border-border bg-background">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={{ box: BoxNode }} fitView fitViewOptions={{ padding: 0.08 }} minZoom={0.3}>
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
