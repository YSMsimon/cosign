"use client";

/**
 * Approving and cancelling treasury payments: the API prepares the transaction, the person's own wallet signs and
 * sends it, and we wait for Arc. Shared by the chat's payment card and the Treasury ledger.
 */
import { api } from "@/lib/client/api";
import { invalidate } from "@/lib/client/data";
import { ARC, sendPrepared, walletErrorText } from "@/lib/client/wallet";
import { useCosign } from "./cosign";

/** The words for each step, the same as the design board's. */
export const STEPS = {
  approve: ["Connecting to your wallet…", "Waiting for your signature…", "Sending your approval to the treasury on Arc…"],
  deny: ["Connecting to your wallet…", "Waiting for your signature…", "Cancelling the proposal on Arc…"],
};

export const txUrl = (hash: string) => `${ARC.blockExplorers.default.url}/tx/${hash}`;

export function useTreasuryActions() {
  const { wsId, address } = useCosign();
  const run = async (kind: "approve" | "deny", pid: number, step?: (i: number) => void) => {
    try {
      const { tx } = kind === "approve" ? await api.cosignTx(wsId, pid) : await api.cancelTx(wsId, pid);
      const hash = await sendPrepared(tx, address, step);
      // the proposal, the balance and the activity all changed
      invalidate("proposals:", `ws:${wsId}`, "activity:", "spend:");
      return hash;
    } catch (e) {
      throw new Error(walletErrorText(e));
    }
  };
  return {
    cosign: (pid: number, step?: (i: number) => void) => run("approve", pid, step),
    cancel: (pid: number, step?: (i: number) => void) => run("deny", pid, step),
  };
}
