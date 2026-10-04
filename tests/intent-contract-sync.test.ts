/**
 * Vercel builds `web/` alone (pay-deploy.yml `vercel build`, project root is
 * web/). Files outside web/ are not in that build, so the pay page cannot
 * import repo-root `src/intent.ts`. The contract is vendored at
 * `web/src/lib/intent.ts` instead — the same idea as
 * `supabase/functions/crypto-payments/src`, which is a copy of `src/` made
 * before the edge deploy.
 *
 * These two copies must stay byte-identical. Mutating either side without
 * the other fails here, before a pay-page HMAC mismatch ships.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SOURCE = join(ROOT, "src", "intent.ts");
const VENDORED = join(ROOT, "web", "src", "lib", "intent.ts");

describe("vendored checkout intent contract", () => {
  it("web/src/lib/intent.ts is a byte-identical copy of src/intent.ts", () => {
    const source = readFileSync(SOURCE);
    const vendored = readFileSync(VENDORED);
    expect(Buffer.compare(source, vendored)).toBe(0);
  });
});
