"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard, TableCardBody } from "@/components/ui/table-card";
import { Tag } from "@/components/ui/tag";
import { EXPLORER, short, TREASURY, Usdc, walletOf } from "./money";
import { AgentOrb } from "./parts";
import { useAgents } from "./store";

function CopyOpen({ address, label }: { address: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label={`${label} on the explorer`} asChild>
        <a href={`${EXPLORER}${address}`} target="_blank" rel="noreferrer">
          <ExternalLink />
        </a>
      </Button>
    </>
  );
}

/**
 * Every address in one table (Simon picked it for the Permissions page, 2026-11-14): the workspace's treasury
 * contract, then each agent's own wallet, its balance and what it may do on the treasury.
 */
export function WalletsTable() {
  const { agents } = useAgents();
  return (
    <TableCard>
      <TableCardBody>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Who</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Balance</TableHead>
              <TableHead>On the treasury</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>
                <span className="inline-flex items-center gap-2 font-medium">
                  <Landmark className="size-4" /> Treasury contract
                </span>
              </TableCell>
              <TableCell className="font-mono text-xs">{short(TREASURY.address)}</TableCell>
              <TableCell>
                <Usdc amount={TREASURY.usdc} />
              </TableCell>
              <TableCell>
                <Tag size="sm">
                  {TREASURY.threshold} of {TREASURY.approvers} approve
                </Tag>
              </TableCell>
              <TableCell className="text-right">
                <CopyOpen address={TREASURY.address} label="treasury address" />
              </TableCell>
            </TableRow>
            {agents.map((a) => {
              const w = walletOf(a.id);
              const roles = [w.drafts && "Drafts payments", w.pettyCash && "Petty cash"].filter(Boolean) as string[];
              return (
                <TableRow key={a.id}>
                  <TableCell>
                    <span className="inline-flex items-center gap-2 font-medium">
                      <AgentOrb hue={a.hue} still className="size-5" /> {a.name}&apos;s wallet
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{short(w.address)}</TableCell>
                  <TableCell>
                    <Usdc amount={w.usdc} />
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      {roles.length ? (
                        roles.map((r) => (
                          <Tag key={r} size="sm" variant="info">
                            {r}
                          </Tag>
                        ))
                      ) : (
                        <Tag size="sm" variant="secondary">
                          No money
                        </Tag>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <CopyOpen address={w.address} label={`${a.name}'s wallet address`} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableCardBody>
    </TableCard>
  );
}
