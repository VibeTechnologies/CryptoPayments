import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DB } from "../src/db.js";

// ── Env vars must be set BEFORE importing server.ts ──────────────────────────
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.API_KEY = "test-api-key";
process.env.CALLBACK_SECRET = "test-callback-secret";
process.env.TELEGRAM_BOT_TOKEN = "123456:TestBotToken";
process.env.WALLET_BASE = "0xTestBaseWallet";
process.env.WALLET_ETH = "0xTestEthWallet";
process.env.WALLET_TON = "EQTestTonWallet";
process.env.WALLET_SOL = "TestSolWallet";
process.env.PORT = "0";

// ── Mock @hono/node-server to prevent actual server start ────────────────────
vi.mock("@hono/node-server", () => ({
  serve: vi.fn(),
}));

vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => async (_c: any, next: any) => next(),
}));

// ── Mock verify to avoid real RPC calls ──────────────────────────────────────
vi.mock("../src/verify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verify.js")>();
  return {
    ...actual,
    verifyTransfer: vi.fn(),
  };
});

// ── Mock Supabase client (in-memory) ─────────────────────────────────────────

function createMockSupabase(): DB {
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
    let table = stores[tableName] ?? [];
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
      select(_cols: string = "*") {
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
          let result: any;

          if (isInsert && insertData) {
            // Unique constraint: payment_intents (tx_hash + chain_id)
            if (tableName === "payment_intents" && insertData.tx_hash) {
              const dup = table.find(
                (r: any) =>
                  r.tx_hash === insertData!.tx_hash &&
                  r.chain_id === insertData!.chain_id,
              );
              if (dup) {
                return resolve({
                  data: null,
                  error: {
                    message:
                      "duplicate key value violates unique constraint",
                  },
                });
              }
            }
            // Unique constraint: customers (id_type + uid)
            if (tableName === "customers" && insertData.id_type) {
              const dup = table.find(
                (r: any) =>
                  r.id_type === insertData!.id_type &&
                  r.uid === insertData!.uid,
              );
              if (dup) {
                return resolve({
                  data: null,
                  error: {
                    message:
                      "duplicate key value violates unique constraint",
                  },
                });
              }
            }
            table.push(insertData);
            stores[tableName] = table;
            result = {
              data: isSelect ? { ...insertData } : null,
              error: null,
            };
          } else if (isUpdate && updateData) {
            let matched = table;
            for (const f of filters) {
              matched = matched.filter((r: any) => r[f.col] === f.val);
            }
            for (const row of matched) {
              Object.assign(row, updateData, {
                updated_at: new Date().toISOString(),
              });
            }
            result = {
              data: isSelect
                ? isSingle
                  ? matched[0] ?? null
                  : matched
                : null,
              error: null,
            };
          } else {
            // Select query
            let matched = table;
            for (const f of filters) {
              matched = matched.filter((r: any) => r[f.col] === f.val);
            }
            if (ordering) {
              matched.sort((a: any, b: any) => {
                const aVal = a[ordering!.col];
                const bVal = b[ordering!.col];
                return ordering!.ascending
                  ? aVal > bVal
                    ? 1
                    : -1
                  : aVal < bVal
                    ? 1
                    : -1;
              });
            }
            matched = matched.slice(rangeStart, rangeEnd + 1);

            if (isSingle) {
              result = {
                data: matched[0] ?? null,
                error:
                  matched.length === 0 ? { code: "PGRST116" } : null,
              };
            } else {
              result = { data: matched, error: null };
            }
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

  return {
    from(tableName: string) {
      return makeChain(tableName);
    },
  } as unknown as DB;
}

// ── Import after env + mocks are set ─────────────────────────────────────────
const { createApp } = await import("../src/server.js");
const { verifyTransfer } = await import("../src/verify.js");
const mockedVerifyTransfer = vi.mocked(verifyTransfer);

describe("Crypto topup E2E — callback flow", () => {
  let app: ReturnType<typeof createApp>;
  let mockDb: DB;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockSupabase();
    app = createApp(mockDb);
  });

  it("topup=small payment triggers callback with topup field and no plan", async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: any, init?: any) => {
      fetchCalls.push({ url: String(url), init });
      return new Response("OK", { status: 200 });
    }) as any;

    mockedVerifyTransfer.mockResolvedValueOnce({
      from: "0xSender",
      to: "0xTestBaseWallet",
      amountRaw: "5000000",
      amountUsd: 5,
      token: "usdc",
      blockNumber: 20001,
      txHash: "0xe2e_topup_small_tx",
    });

    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xe2e_topup_small_tx",
        chainId: "base",
        token: "usdc",
        idType: "tg",
        uid: "42",
        topup: "small",
        apiKey: "test-api-key",
        callbackUrl: "https://bot.example.com/webhook",
      }),
    });

    expect(res.status).toBe(200);
    const resBody = await res.json();
    expect(resBody.payment.topup_id).toBe("small");

    // The callback is fired async (sendCallback().catch()), give it a tick
    await new Promise((r) => setTimeout(r, 100));

    const callbackCall = fetchCalls.find(
      (c) => c.url === "https://bot.example.com/webhook",
    );
    expect(callbackCall).toBeDefined();
    expect(callbackCall!.init.method).toBe("POST");

    const body = JSON.parse(callbackCall!.init.body as string);
    expect(body.payment.topup).toBe("small");
    // plan should be absent — no plan was submitted
    expect(body.payment.plan).toBeUndefined();

    globalThis.fetch = originalFetch;
  });

  it("plan=pro payment callback has plan field and no topup field", async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: any, init?: any) => {
      fetchCalls.push({ url: String(url), init });
      return new Response("OK", { status: 200 });
    }) as any;

    mockedVerifyTransfer.mockResolvedValueOnce({
      from: "0xSender",
      to: "0xTestBaseWallet",
      amountRaw: "25000000",
      amountUsd: 25,
      token: "usdc",
      blockNumber: 20002,
      txHash: "0xe2e_plan_pro_tx",
    });

    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xe2e_plan_pro_tx",
        chainId: "base",
        token: "usdc",
        idType: "tg",
        uid: "42",
        plan: "pro",
        apiKey: "test-api-key",
        callbackUrl: "https://bot.example.com/webhook",
      }),
    });

    expect(res.status).toBe(200);
    const resBody = await res.json();
    expect(resBody.payment.plan_id).toBe("pro");
    expect(resBody.payment.topup_id).toBeNull();

    await new Promise((r) => setTimeout(r, 100));

    const callbackCall = fetchCalls.find(
      (c) => c.url === "https://bot.example.com/webhook",
    );
    expect(callbackCall).toBeDefined();

    const body = JSON.parse(callbackCall!.init.body as string);
    expect(body.payment.plan).toBe("pro");
    expect(body.payment.topup).toBeUndefined();

    globalThis.fetch = originalFetch;
  });

  it("topup=medium stores topup_id=medium in payment record", async () => {
    mockedVerifyTransfer.mockResolvedValueOnce({
      from: "0xSender",
      to: "0xTestBaseWallet",
      amountRaw: "10000000",
      amountUsd: 10,
      token: "usdc",
      blockNumber: 20003,
      txHash: "0xe2e_topup_medium_tx",
    });

    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xe2e_topup_medium_tx",
        chainId: "base",
        token: "usdc",
        idType: "tg",
        uid: "42",
        topup: "medium",
        apiKey: "test-api-key",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payment.status).toBe("verified");
    expect(body.payment.topup_id).toBe("medium");
    // plan_id may be resolved from amount by resolveplan; topup_id is the discriminator
  });
});
