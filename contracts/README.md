# Cosign contracts (Arc Foundry)

- `src/CompanyTreasury.sol`: holds a company's USDC. Agents and members **propose**; human approvers
  **cosign**; payment executes when approvals reach the threshold. Agents get a capped weekly
  petty-cash allowance (`topUpAgent`). Guardians can only pause; only approvers can unpause.
  Approvers can be added or removed and the threshold changed with `proposeApproverChange`, which
  executes after the same number of cosigns as a payment (so one approver can't take over a
  multi-signer treasury). Only current approvers' cosigns count, and approver changes still work
  while the treasury is paused. Accepts plain USDC sends via `receive()` (on Arc, USDC is the native coin).
- `src/TreasuryFactory.sol`: ownerless factory; `createTreasury(name, approvers, proposers, threshold)`.

## Arc testnet deployments

| Contract | Address |
|---|---|
| TreasuryFactory (v3, approver management) | `0xB794E55ed8b6833AF935c8a8bbD5B3b76f063D79` |
| Demo treasury "Nova Labs (demo)" | `0xb496FD2D5b29A5b12Ee3d30e7359578fec86e62c` |

Earlier v2 factory `0x77cd33Bc2a38bFdB0e7B36e26D1c5b8AB5Da510F` (fixed approvers) is retired; its demo
treasury was emptied back to the CFO.

USDC (ERC-20 interface): `0x3600000000000000000000000000000000000000` (6 decimals).

## Commands

```bash
arc-forge build --force && arc-forge test
python3 ../scripts/forge-env.py script script/Deploy.s.sol --rpc-url arc_testnet --broadcast
cd .. && pnpm tsx scripts/gen-abis.ts <factoryAddress> "<label>"   # regenerate src/lib/contracts/abis.ts
```
