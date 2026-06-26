#!/usr/bin/env tsx
/**
 * E2E server wrapper for agentUSD Anvil testnet test.
 *
 * Starts the real CryptoPayments Hono app with:
 *   - In-memory mock DB (no Supabase needed)
 *   - TOKEN_ADDRESSES.base_sepolia.{usdc,usdt} patched to AGENT_USD_CONTRACT
 *   - RPC_BASE_SEPOLIA pointing at local Anvil
 *   - WALLET_BASE_SEPOLIA as the ERC20 transfer recipient
 *
 * Required env vars:
 *   AGENT_USD_CONTRACT   deployed agentUSD address on Anvil
 *   RPC_BASE_SEPOLIA     Anvil RPC URL (default: http://localhost:8546)
 *   WALLET_BASE_SEPOLIA  recipient wallet address
 *   CALLBACK_SECRET      HMAC secret for callbacks
 *   PORT                 listen port (default: 9999)
 */

// ── Env vars — set BEFORE any imports that read them ─────────────────────────
// Use PORT=0 so server.ts module-level auto-start doesn't collide with ours.
const LISTEN_PORT = Number(process.env.PORT ?? "9999");
process.env.PORT = "0"; // prevent server.ts auto-start from using our port
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.CALLBACK_SECRET = process.env.CALLBACK_SECRET ?? "testsecret";
process.env.RPC_BASE_SEPOLIA = process.env.RPC_BASE_SEPOLIA ?? "http://localhost:8546";
process.env.WALLET_BASE_SEPOLIA =
  process.env.WALLET_BASE_SEPOLIA ?? "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
// Placeholder wallets for other chains (not used in this test)
process.env.WALLET_BASE = process.env.WALLET_BASE ?? "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
process.env.WALLET_ETH = process.env.WALLET_ETH ?? "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
process.env.WALLET_TON = process.env.WALLET_TON ?? "EQTestTonWallet";
process.env.WALLET_SOL = process.env.WALLET_SOL ?? "TestSolWallet";
// No API_KEY: requireApiKey() returns true for all requests (open)

// ── Validate required env var ─────────────────────────────────────────────────
const agentUsdContract = process.env.AGENT_USD_CONTRACT;
if (!agentUsdContract) {
  console.error("ERROR: AGENT_USD_CONTRACT env var is required");
  process.exit(1);
}

// ── Patch TOKEN_ADDRESSES before server.ts imports config ────────────────────
// All modules share the same ES module cache. Patching the object here means
// verify.ts will see our agentUSD address instead of the real Circle USDC.
const { TOKEN_ADDRESSES } = await import("../src/config.js");
TOKEN_ADDRESSES.base_sepolia.usdc = agentUsdContract;
TOKEN_ADDRESSES.base_sepolia.usdt = agentUsdContract;
console.log(
  `[wrapper] TOKEN_ADDRESSES.base_sepolia patched → usdc/usdt = ${agentUsdContract}`,
);

// ── In-memory mock DB ─────────────────────────────────────────────────────────
// Mirrors the mock DB used in server.test.ts / e2e-topup.test.ts.
import type { DB } from "../src/db.js";

function createMockDb(): DB {
  const stores: Record<string, Record<string, unknown>[]> = {
    customers: [],
    payment_intents: [],
    invoices: [],
    invoice_line_items: [],
    checkout_sessions: [],
    webhook_events: [],
  };
  let idCounter = 0;

  function makeChain(tableName: string) {
    let filters: Array<{ col: string; val: unknown }> = [];
    let isSingle = false;
    let isInsert = false;
    let isUpdate = false;
    let isSelect = false;
    let insertData: Record<string, unknown> | null = null;
    let updateData: Record<string, unknown> | null = null;
    let ordering: { col: string; ascending: boolean } | null = null;
    let rangeStart = 0;
    let rangeEnd = Infinity;

    const chain: any = {
      select(_cols = "*") {
        isSelect = true;
        return chain;
      },
      insert(data: Record<string, unknown>) {
        isInsert = true;
        insertData = {
          id: `uuid-${++idCounter}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...data,
        };
        return chain;
      },
      update(data: Record<string, unknown>) {
        isUpdate = true;
        updateData = data;
        return chain;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, val });
        return chain;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        ordering = { col, ascending: opts?.ascending ?? true };
        return chain;
      },
      range(start: number, end: number) {
        rangeStart = start;
        rangeEnd = end;
        return chain;
      },
      single() {
        isSingle = true;
        return chain;
      },
      then(resolve: (val: any) => void, reject?: (err: any) => void) {
        try {
          const t: Record<string, unknown>[] = stores[tableName] ?? [];
          let result: any;

          if (isInsert && insertData) {
            // Unique constraint: payment_intents (tx_hash + chain_id)
            if (tableName === "payment_intents" && insertData.tx_hash) {
              const dup = t.find(
                (r: any) =>
                  r.tx_hash === insertData!.tx_hash &&
                  r.chain_id === insertData!.chain_id,
              );
              if (dup) {
                return resolve({
                  data: null,
                  error: { message: "duplicate key value violates unique constraint" },
                });
              }
            }
            // Unique constraint: customers (id_type + uid)
            if (tableName === "customers" && insertData.id_type) {
              const dup = t.find(
                (r: any) =>
                  r.id_type === insertData!.id_type && r.uid === insertData!.uid,
              );
              if (dup) {
                return resolve({
                  data: null,
                  error: { message: "duplicate key value violates unique constraint" },
                });
              }
            }
            t.push(insertData);
            stores[tableName] = t;
            result = { data: isSelect ? { ...insertData } : null, error: null };
          } else if (isUpdate && updateData) {
            let matched = t;
            for (const f of filters) {
              matched = matched.filter((r: any) => r[f.col] === f.val);
            }
            for (const row of matched) {
              Object.assign(row, updateData, { updated_at: new Date().toISOString() });
            }
            result = {
              data: isSelect ? (isSingle ? matched[0] ?? null : matched) : null,
              error: null,
            };
          } else {
            // Select
            let matched = t;
            for (const f of filters) {
              matched = matched.filter((r: any) => r[f.col] === f.val);
            }
            if (ordering) {
              matched.sort((a: any, b: any) =>
                ordering!.ascending
                  ? a[ordering!.col] > b[ordering!.col]
                    ? 1
                    : -1
                  : a[ordering!.col] < b[ordering!.col]
                    ? 1
                    : -1,
              );
            }
            const slice = rangeEnd === Infinity ? matched : matched.slice(rangeStart, rangeEnd + 1);
            result = isSingle
              ? { data: slice[0] ?? null, error: slice.length === 0 ? { code: "PGRST116" } : null }
              : { data: slice, error: null };
          }

          resolve(result);
        } catch (err) {
          if (reject) reject(err);
          else resolve({ data: null, error: { message: String(err) } });
        }
      },
    };
    return chain;
  }

  return { from: (tableName: string) => makeChain(tableName) } as unknown as DB;
}

// ── Import server (module-level code runs here) ───────────────────────────────
// server.ts will try to auto-start on PORT=0 (random OS port) — we ignore that.
const { createApp } = await import("../src/server.js");
const { serve } = await import("@hono/node-server");

// ── Start our mock app on the real port ──────────────────────────────────────
const mockDb = createMockDb();
const app = createApp(mockDb);

serve({ fetch: app.fetch, port: LISTEN_PORT }, () => {
  console.log(`[wrapper] E2E server ready on http://localhost:${LISTEN_PORT}`);
});
