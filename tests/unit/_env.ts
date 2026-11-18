// Imported first by every unit test: a throwaway SQLite file and test-only secrets. No network.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "cosign-unit-"));
process.env.COSIGN_DB = join(dir, "test.db");
process.env.COSIGN_SECRET ??= "unit-test-secret-unit-test-secret-0123456789";
process.env.SANDBOX_ROOT = join(dir, "sandboxes");
// the x402 seller signs nothing in unit tests, but needs a key to load: Anvil's public test account #0 (never funded)
process.env.SELLER_PRIVATE_KEY ??= "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
