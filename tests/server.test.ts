import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DB, PaymentRecord } from "../src/db.js";

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

describe("Server API", () => {
  let app: ReturnType<typeof createApp>;
  let mockDb: DB;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockSupabase();
    app = createApp(mockDb);
  });

  // ── Health ──

  describe("GET /api/health", () => {
    it("returns ok", async () => {
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.chains).toContain("base");
    });
  });

  // ── Config ──

  describe("GET /api/config", () => {
    it("returns wallets and prices", async () => {
      const res = await app.request("/api/config");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.wallets).toBeDefined();
      expect(body.prices.starter).toBe(10);
      expect(body.prices.pro).toBe(25);
      expect(body.prices.max).toBe(100);
      expect(body.chains).toEqual(["base", "eth", "ton", "sol", "base_sepolia"]);
    });
  });

  // ── Payment page ──

  describe("GET /", () => {
    it("returns HTML payment page", async () => {
      const res = await app.request("/");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Pay with Crypto");
      expect(html).toContain("telegram-web-app.js");
      expect(html).toContain("OpenClaw");
    });
  });

  // ── POST /api/payment ──

  describe("POST /api/payment", () => {
    it("rejects missing txHash", async () => {
      const res = await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainId: "base",
          token: "usdc",
          idType: "tg",
          uid: "123",
          apiKey: "test-api-key",
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("txHash");
    });

    it("rejects invalid chainId", async () => {
      const res = await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xabc",
          chainId: "invalid",
          token: "usdc",
          idType: "tg",
          uid: "123",
          apiKey: "test-api-key",
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("chainId");
    });

    it("rejects invalid API key", async () => {
      const res = await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xabc",
          chainId: "base",
          token: "usdc",
          idType: "tg",
          uid: "123",
          apiKey: "wrong-key",
        }),
      });
      expect(res.status).toBe(401);
    });

    it("submits payment and verifies on-chain (success)", async () => {
      mockedVerifyTransfer.mockResolvedValueOnce({
        from: "0xSender",
        to: "0xTestBaseWallet",
        amountRaw: "10000000",
        amountUsd: 10,
        token: "usdc",
        blockNumber: 12345,
        txHash: "0xvalidtx1",
      });

      const res = await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xvalidtx1",
          chainId: "base",
          token: "usdc",
          idType: "tg",
          uid: "42",
          plan: "starter",
          apiKey: "test-api-key",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.payment.status).toBe("verified");
      expect(body.payment.amount_usd).toBe(10);
      expect(body.payment.plan_id).toBe("starter");
      // Payment IDs are now stripe-style pi_... strings
      expect(body.payment.id).toMatch(/^pi_/);
    });

    it("returns 409 for duplicate tx submission", async () => {
      // First, submit a valid payment
      mockedVerifyTransfer.mockResolvedValueOnce({
        from: "0xSender",
        to: "0xTestBaseWallet",
        amountRaw: "10000000",
        amountUsd: 10,
        token: "usdc",
        blockNumber: 12345,
        txHash: "0xduplicatetx",
      });

      await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xduplicatetx",
          chainId: "base",
          token: "usdc",
          idType: "tg",
          uid: "42",
          apiKey: "test-api-key",
        }),
      });

      // Then submit the same tx again
      const res = await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xduplicatetx",
          chainId: "base",
          token: "usdc",
          idType: "tg",
          uid: "42",
          apiKey: "test-api-key",
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain("already submitted");
    });

    it("marks payment failed when verification returns null", async () => {
      mockedVerifyTransfer.mockResolvedValueOnce(null);

      const res = await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xnotfound",
          chainId: "eth",
          token: "usdt",
          idType: "tg",
          uid: "42",
          apiKey: "test-api-key",
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("not found");
      expect(body.payment.status).toBe("failed");
    });

    it("handles verification error gracefully", async () => {
      mockedVerifyTransfer.mockRejectedValueOnce(new Error("RPC timeout"));

      const res = await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xrpcfail",
          chainId: "base",
          token: "usdc",
          idType: "tg",
          uid: "42",
          apiKey: "test-api-key",
        }),
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("RPC timeout");
      expect(body.payment.status).toBe("failed");
    });

    it("accepts base_sepolia as valid chainId", async () => {
      mockedVerifyTransfer.mockResolvedValueOnce({
        from: "0xSender",
        to: "0xTestBaseWallet",
        amountRaw: "10000000",
        amountUsd: 10,
        token: "usdc",
        blockNumber: 54321,
        txHash: "0xsepolia_tx",
      });

      const res = await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xsepolia_tx",
          chainId: "base_sepolia",
          token: "usdc",
          idType: "tg",
          uid: "42",
          plan: "starter",
          apiKey: "test-api-key",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.payment.status).toBe("verified");
      expect(body.payment.chain_id).toBe("base_sepolia");
    });

    it("resolves plan from amount when not specified", async () => {
      mockedVerifyTransfer.mockResolvedValueOnce({
        from: "0xSender",
        to: "0xTestBaseWallet",
        amountRaw: "25000000",
        amountUsd: 25,
        token: "usdt",
        blockNumber: 99999,
        txHash: "0xpro_plan_tx",
      });

      const res = await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xpro_plan_tx",
          chainId: "base",
          token: "usdt",
          idType: "tg",
          uid: "42",
          apiKey: "test-api-key",
          // no plan specified — should be resolved from amount
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.payment.plan_id).toBe("pro");
    });
  });

  // ── GET /api/payment/:id ──

  describe("GET /api/payment/:id", () => {
    it("rejects without API key", async () => {
      const res = await app.request("/api/payment/pi_test123");
      expect(res.status).toBe(401);
    });

    it("returns payment by ID with valid API key", async () => {
      // First create a payment
      mockedVerifyTransfer.mockResolvedValueOnce({
        from: "0xSender",
        to: "0xTestBaseWallet",
        amountRaw: "10000000",
        amountUsd: 10,
        token: "usdc",
        blockNumber: 12345,
        txHash: "0xfetchme",
      });

      const createRes = await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xfetchme",
          chainId: "base",
          token: "usdc",
          idType: "tg",
          uid: "100",
          apiKey: "test-api-key",
        }),
      });
      const created = await createRes.json();
      const paymentId = created.payment.id;

      const res = await app.request(
        `/api/payment/${paymentId}?api_key=test-api-key`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.payment).toBeDefined();
      expect(body.payment.id).toBe(paymentId);
    });

    it("returns 404 for non-existent payment", async () => {
      const res = await app.request(
        "/api/payment/pi_nonexistent?api_key=test-api-key",
      );
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid ID", async () => {
      const res = await app.request("/api/payment/abc?api_key=test-api-key");
      expect(res.status).toBe(400);
    });
  });

  // ── GET /api/payments ──

  describe("GET /api/payments", () => {
    it("rejects without API key", async () => {
      const res = await app.request("/api/payments?idtype=tg&uid=42");
      expect(res.status).toBe(401);
    });

    it("requires idtype and uid params", async () => {
      const res = await app.request("/api/payments?api_key=test-api-key");
      expect(res.status).toBe(400);
    });

    it("returns user payments", async () => {
      // Create a payment first
      mockedVerifyTransfer.mockResolvedValueOnce({
        from: "0xSender",
        to: "0xTestBaseWallet",
        amountRaw: "10000000",
        amountUsd: 10,
        token: "usdc",
        blockNumber: 12345,
        txHash: "0xlistme",
      });

      await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xlistme",
          chainId: "base",
          token: "usdc",
          idType: "tg",
          uid: "42",
          apiKey: "test-api-key",
        }),
      });

      const res = await app.request(
        "/api/payments?idtype=tg&uid=42&api_key=test-api-key",
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.payments).toBeDefined();
      expect(Array.isArray(body.payments)).toBe(true);
      expect(body.payments.length).toBeGreaterThanOrEqual(1);
    });
  });
});
