"use client";

/**
 * An agent's funding request (request_funds), for the people who may add money: Approve opens Circle's onramp for the
 * workspace treasury in a new tab, where the person pays (the agent never sees payment details, and the money only ever
 * goes to the treasury); Deny declines it. The same Approval Row as every other ask.
 */
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/client/api";
import { useData } from "@/lib/client/data";
import { shortAddr } from "@/lib/client/wallet";
import { ApprovalRow } from "../../mockups/v2/parts";
import { useCosign } from "../cosign";

const usd = (x: unknown) => `$${Number(x).toFixed(2)}`;

export function FundingCard({ requestId }: { requestId: string }) {
  const { wsId, ws, can } = useCosign();
  const requests = useData(`funding:${wsId}`, () => api.fundingRequests(wsId));
  const r = requests.data?.requests.find((x) => x.id === requestId);
  if (requests.loading) return <Skeleton className="h-16 rounded-xl" />;
  if (!r) return null;
  const mayAdd = can("payments.cosign") || can("workspace.manage");
  const decided = r.status === "pending" ? "open" : r.status === "declined" ? "denied" : "approved";
  return (
    <ApprovalRow
      title={`Add ${usd(r.amountUsd)} to the treasury?`}
      description={`${r.reason}. You pay in Circle's onramp (sandbox on testnet); the USDC goes to the treasury.`}
      address={{ value: ws.treasury.address, label: "the treasury's address" }}
      decision={decided}
      waiting={r.status === "pending" && !mayAdd ? "Waiting for an approver to add funds." : undefined}
      approved={{ title: "Opened Circle's onramp", note: `Pay in the new tab. The USDC lands in the treasury (${shortAddr(ws.treasury.address)}).` }}
      denied={{ title: "Declined", note: "Nothing was bought" }}
      pending={["Opening Circle's onramp…"]}
      act={async (yes, step) => {
        if (!yes) {
          await api.declineFunding(wsId, r.id);
          requests.reload();
          return;
        }
        // open the tab inside the click, so the browser doesn't block it; it gets the onramp's address once we have it
        const tab = window.open("about:blank", "_blank");
        step(0);
        try {
          const s = await api.onramp(wsId, { requestId: r.id });
          if (tab) tab.location.href = s.widgetUrl;
          else window.open(s.widgetUrl, "_blank");
          requests.reload();
          return { note: `Pay in the new tab${s.sandbox ? " (Circle's sandbox: test payments only)" : ""}. The USDC lands in the treasury (${shortAddr(s.destination)}).` };
        } catch (e) {
          tab?.close();
          throw e;
        }
      }}
    />
  );
}
