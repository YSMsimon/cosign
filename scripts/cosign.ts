/**
 * Act as the human approver (Test CFO) from the terminal, to finish what an agent drafted.
 *   pnpm cosign                               list open proposals and the approvers
 *   pnpm cosign <id>                          cosign proposal <id> (executes it once enough approvers cosign)
 *   pnpm cosign cancel <id>                   cancel it instead
 *   pnpm cosign add-approver <address> [n]    propose adding an approver (optionally set the threshold to n)
 *   pnpm cosign remove-approver <address> [n] propose removing an approver (optionally set the threshold to n)
 *   pnpm cosign threshold <n>                 propose changing how many cosigns a proposal needs
 * Approver changes are proposals too: cosign them with `pnpm cosign <id>`.
 */
import { readFileSync } from "node:fs";
import { zeroAddress, type Address } from "viem";
import { approvePayment, cancelProposal, chain, explorerTx, fmt, proposeApproverChange, treasuryState } from "../src/lib/arc";
import { companyTreasuryAbi } from "../src/lib/contracts/abis";

type Proposal = { kind: number; to: string; amount: bigint; newThreshold: number; proposer: string; approvals: number; executed: boolean; cancelled: boolean; memo: string };
const KINDS = ["payment", "add approver", "remove approver", "set threshold"];

(async () => {
  const treasury = JSON.parse(readFileSync("data/treasury.local.json", "utf8")).treasury as Address;
  const [a, b, c] = process.argv.slice(2);
  const change = async (kind: "add" | "remove" | "threshold", account: Address, n: number) => {
    const r = await proposeApproverChange("test-cfo", treasury, kind, account, n, `${kind} via terminal`);
    console.log(`proposed #${r.id} (${kind}${kind === "threshold" ? ` ${n}` : ` ${account}`}${kind !== "threshold" && n ? `, threshold → ${n}` : ""}): ${explorerTx(r.hash)}`);
    console.log(`cosign it with: pnpm cosign ${r.id}`);
  };
  if (a === "cancel" && b) {
    const r = await cancelProposal("test-cfo", treasury, BigInt(b));
    console.log(`cancelled #${b}: ${explorerTx(r.hash)}`);
    return;
  }
  if (a === "add-approver" && b) return change("add", b as Address, Number(c ?? 0));
  if (a === "remove-approver" && b) return change("remove", b as Address, Number(c ?? 0));
  if (a === "threshold" && b) return change("threshold", zeroAddress, Number(b));
  if (a) {
    const r = await approvePayment("test-cfo", treasury, BigInt(a));
    console.log(`CFO cosigned #${a}: ${explorerTx(r.hash)}`);
    console.log(await treasuryState(treasury));
    return;
  }
  const n = Number(await chain.readContract({ address: treasury, abi: companyTreasuryAbi, functionName: "proposalCount" }));
  const st = await treasuryState(treasury);
  console.log(`${st.name} ${treasury} · balance ${st.balance} USDC · needs ${st.threshold} cosign(s) · paused ${st.paused}`);
  console.log(`approvers: ${st.approvers.join(", ")}`);
  let open = 0;
  for (let i = 0; i < n; i++) {
    const p = (await chain.readContract({ address: treasury, abi: companyTreasuryAbi, functionName: "getProposal", args: [BigInt(i)] })) as Proposal;
    if (p.executed || p.cancelled) continue;
    open++;
    const what = p.kind === 0 ? `$${fmt(p.amount)} → ${p.to}` : `${KINDS[p.kind]}${p.kind === 3 ? ` ${p.newThreshold}` : ` ${p.to}`}${p.kind !== 3 && p.newThreshold ? ` (threshold → ${p.newThreshold})` : ""}`;
    console.log(`#${i}  ${what}  "${p.memo}"  (by ${p.proposer}, ${p.approvals}/${st.threshold} cosigns)`);
  }
  if (!open) console.log("no open proposals");
})().catch((e) => {
  console.error("FAILED:", JSON.stringify(e?.response?.data ?? e?.message ?? String(e)));
  process.exit(1);
});
