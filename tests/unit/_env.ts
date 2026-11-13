// Imported first by every unit test: a throwaway SQLite file and test-only secrets. No network.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "cosign-unit-"));
process.env.COSIGN_DB = join(dir, "test.db");
process.env.COSIGN_SECRET ??= "unit-test-secret-unit-test-secret-0123456789";
process.env.SANDBOX_ROOT = join(dir, "sandboxes");
