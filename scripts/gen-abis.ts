/**
 * Regenerate src/lib/contracts/abis.ts from the Foundry build (contracts/out).
 * Run after changing the contracts: pnpm tsx scripts/gen-abis.ts <factoryAddress> "<label>"
 */
import { readFileSync, writeFileSync } from "node:fs";

const [address, label = ""] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) throw new Error("usage: gen-abis.ts <factoryAddress> [label]");
const abi = (name: string) => JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`, "utf8")).abi;

const out = `// Generated from contracts/out by scripts/gen-abis.ts (do not edit by hand). Re-run after changing the contracts.

export const TREASURY_FACTORY_ADDRESS = "${address}" as const; // Arc testnet${label ? `, ${label}` : ""}

export const treasuryFactoryAbi = ${JSON.stringify(abi("TreasuryFactory"), null, 2)} as const;

export const companyTreasuryAbi = ${JSON.stringify(abi("CompanyTreasury"), null, 2)} as const;
`;
writeFileSync("src/lib/contracts/abis.ts", out);
console.log(`wrote src/lib/contracts/abis.ts (factory ${address})`);
