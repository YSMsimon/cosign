"use client";

import { Coins, Terminal, Wallet } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { SectionHeader } from "@/components/section-header";
import { ApprovalRow, Shell } from "../parts";

/** Design board (not in the nav): the Approve row (shadcn Confirmation) used for every action that needs a person. */
export default function ApprovalsBoard() {
  return (
    <Shell page="chat">
      <div className="mx-auto max-w-5xl px-8 py-8">
        <PageHeader
          title="Approvals"
          description="Every action that needs a person gets the same Approve row, treasury payments included."
        />

        <div className="mt-8">
          <SectionHeader title="Actions" description="shadcn AI Elements Confirmation. Once decided, the row becomes one line of the agent's steps." />
          <div className="mt-4 grid grid-cols-2 gap-6">
            <div className="flex flex-col gap-3">
              <ApprovalRow
                icon={<Coins />}
                title="Pay $0.10 for a credit report on Lena?"
                description="QuickNode API · over the $0.05 ask-first limit"
                approved="Paid $0.10 · credit report on Lena"
                denied="Denied · nothing was paid"
                pending={["Telling Clerk it's OK…", "Clerk is paying $0.10 from its own wallet…"]}
              />
              <ApprovalRow
                icon={<Wallet />}
                title="Approve $2.40 to Lena?"
                description="Proposal #5 · you sign in your own wallet"
                approved="Approved · paid $2.40 to Lena"
                denied="Denied · nothing was paid"
                pending={["Connecting to your wallet…", "Waiting for your signature…", "Sending your approval to the treasury on Arc…"]}
              />
              <ApprovalRow
                icon={<Terminal />}
                title="Run python3 work/total.py?"
                description="Runs in Clerk's own computer. No secrets inside."
                approved="Ran python3 work/total.py"
                denied="Denied · didn't run"
                pending={["Running in Clerk's computer…"]}
              />
            </div>
            <div className="flex flex-col gap-3 text-sm text-muted-foreground">
              <p>After a decision:</p>
              <ApprovalRow decision="approved" icon={<Coins />} title="" description="" approved="Paid $0.10 · credit report on Lena" denied="" />
              <ApprovalRow decision="denied" icon={<Terminal />} title="" description="" approved="" denied="Denied · didn't run" />
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}
