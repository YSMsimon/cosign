# Cosign contracts (Arc Foundry)

- `src/CompanyTreasury.sol`: holds a company's USDC. Agents and members **propose**; human approvers
  **cosign**; payment executes when approvals reach the threshold. Agents get a capped weekly
  petty-cash allowance (`topUpAgent`). Guardians (e.g. a watchdog agent) can only pause; only
  approvers can unpause. Accepts plain USDC sends via `receive()` (on Arc, USDC is the native coin).
- `src/TreasuryFactory.sol`: ownerless factory; `createTreasury(name, approvers, proposers, threshold)`.

## Arc testnet deployments

| Contract | Address |
|---|---|
| TreasuryFactory (v2) | `0x77cd33Bc2a38bFdB0e7B36e26D1c5b8AB5Da510F` |
| Demo treasury "Nova Labs (demo)" | `0x3a4bF729718ACc9c5318d0ED575DA1d2FE5dEf3E` |

USDC (ERC-20 interface): `0x3600000000000000000000000000000000000000` (6 decimals).

## Commands

```bash
arc-forge build --force && arc-forge test
python3 ../scripts/forge-env.py script script/Deploy.s.sol --rpc-url arc_testnet --broadcast
```
