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

  // ── TonConnect manifest ──

  describe("GET /tonconnect-manifest.json", () => {
    it("returns TonConnect manifest with required fields", async () => {
      const res = await app.request("/tonconnect-manifest.json");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("OpenClaw Crypto Payments");
      expect(body.url).toBeTruthy();
      expect(body.iconUrl).toContain("favicon");
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

    it("returns wallet addresses for all chains", async () => {
      const res = await app.request("/api/config");
      const body = await res.json();
      expect(body.wallets.base).toBe("0xTestBaseWallet");
      expect(body.wallets.eth).toBe("0xTestEthWallet");
      expect(body.wallets.ton).toBe("EQTestTonWallet");
      expect(body.wallets.sol).toBe("TestSolWallet");
      // base_sepolia falls back to WALLET_BASE when WALLET_BASE_SEPOLIA is not set
      expect(body.wallets.base_sepolia).toBe("0xTestBaseWallet");
    });

    it("returns TOKEN_ADDRESSES for all chains", async () => {
      const res = await app.request("/api/config");
      const body = await res.json();
      expect(body.tokens).toBeDefined();
      // Verify all 5 chains have usdt + usdc entries
      for (const chain of ["base", "eth", "ton", "sol", "base_sepolia"]) {
        expect(body.tokens[chain]).toBeDefined();
        expect(body.tokens[chain].usdt).toBeDefined();
        expect(body.tokens[chain].usdc).toBeDefined();
      }
      // Spot-check known contract addresses
      expect(body.tokens.base.usdc).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
      expect(body.tokens.base_sepolia.usdc).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
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

    it("returns text/html Content-Type", async () => {
      const res = await app.request("/");
      expect(res.headers.get("content-type")).toContain("text/html");
    });

    it("contains all critical DOM element IDs", async () => {
      const res = await app.request("/");
      const html = await res.text();
      for (const id of [
        "walletAddress",
        "txHashInput",
        "submitBtn",
        "chainBadges",
        "amountDisplay",
        "tokenDisplay",
        "userInfo",
        "statusMsg",
      ]) {
        expect(html).toContain(`id="${id}"`);
      }
    });

    it("contains chain badges for all 5 chains", async () => {
      const res = await app.request("/");
      const html = await res.text();
      for (const chain of ["base", "eth", "sol", "ton", "base_sepolia"]) {
        expect(html).toContain(`data-chain="${chain}"`);
      }
      // Verify human-readable chain names are present
      for (const name of ["Base", "Ethereum", "Solana", "TON", "Base Sepolia"]) {
        expect(html).toContain(name);
      }
    });

    it("includes Web3 wallet integration scripts and buttons", async () => {
      const res = await app.request("/");
      const html = await res.text();
      // CDN scripts for ethers.js and TonConnect
      expect(html).toContain("ethers");
      expect(html).toContain("tonconnect-ui");
      // Wallet connect buttons
      expect(html).toContain("evmWalletBtn");
      expect(html).toContain("solWalletBtn");
      expect(html).toContain("ton-connect-button");
      // Wallet send button
      expect(html).toContain("sendTxBtn");
      expect(html).toContain("Send Payment via Wallet");
    });
  });

  describe("GET /pay", () => {
    it("returns same HTML payment page as /", async () => {
      const res = await app.request("/pay?plan=starter&uid=123");
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

    it("rejects missing uid", async () => {
      const res = await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xabc",
          chainId: "base",
          token: "usdc",
          idType: "tg",
          uid: "",
          apiKey: "test-api-key",
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("uid");
    });

    it("rejects missing idType", async () => {
      const res = await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xabc",
          chainId: "base",
          token: "usdc",
          uid: "123",
          apiKey: "test-api-key",
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("idType");
    });

    it("rejects invalid token value", async () => {
      const res = await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xabc",
          chainId: "base",
          token: "dai",
          idType: "tg",
          uid: "123",
          apiKey: "test-api-key",
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("token");
    });

    it("defaults token to usdt when not specified", async () => {
      mockedVerifyTransfer.mockResolvedValueOnce({
        from: "0xSender",
        to: "0xTestBaseWallet",
        amountRaw: "10000000",
        amountUsd: 10,
        token: "usdt",
        blockNumber: 12345,
        txHash: "0xdefault_token_tx",
      });

      const res = await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xdefault_token_tx",
          chainId: "base",
          // no token field
          idType: "tg",
          uid: "42",
          plan: "starter",
          apiKey: "test-api-key",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.payment.status).toBe("verified");
      expect(body.payment.token).toBe("usdt");
    });

    it("proceeds without auth when no apiKey or initData provided", async () => {
      mockedVerifyTransfer.mockResolvedValueOnce({
        from: "0xSender",
        to: "0xTestBaseWallet",
        amountRaw: "10000000",
        amountUsd: 10,
        token: "usdc",
        blockNumber: 12345,
        txHash: "0xnoauth_tx",
      });

      const res = await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xnoauth_tx",
          chainId: "base",
          token: "usdc",
          idType: "tg",
          uid: "42",
          plan: "starter",
          // no apiKey, no initData
        }),
      });

      // Should NOT return 401 — auth is optional
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.payment.status).toBe("verified");
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

  // ── GET /checkout/:id ──

  describe("GET /checkout/:id", () => {
    it("returns 404 for non-existent checkout session", async () => {
      const res = await app.request("/checkout/cs_nonexistent");
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toContain("not found");
    });

    it("returns 410 for expired checkout session", async () => {
      // Seed an expired session directly into the mock DB
      const db = mockDb as any;
      const table = db.from("checkout_sessions");
      await table.insert({
        stripe_id: "cs_expired_test",
        status: "expired",
        amount: 1000,
        plan_id: "starter",
        url: "http://test/checkout/cs_expired_test",
        expires_at: new Date(Date.now() - 60000).toISOString(),
        metadata: {},
      }).select("*");

      const res = await app.request("/checkout/cs_expired_test");
      expect(res.status).toBe(410);
      const text = await res.text();
      expect(text).toContain("expired");
    });

    it("returns 200 with completion text for completed session", async () => {
      const db = mockDb as any;
      const table = db.from("checkout_sessions");
      await table.insert({
        stripe_id: "cs_complete_test",
        status: "complete",
        amount: 2500,
        plan_id: "pro",
        url: "http://test/checkout/cs_complete_test",
        expires_at: new Date(Date.now() + 60000).toISOString(),
        completed_at: new Date().toISOString(),
        metadata: {},
      }).select("*");

      const res = await app.request("/checkout/cs_complete_test");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("already been completed");
    });

    it("returns HTML checkout page for valid open session", async () => {
      const db = mockDb as any;
      const table = db.from("checkout_sessions");
      await table.insert({
        stripe_id: "cs_open_test",
        status: "open",
        amount: 1000,
        plan_id: "starter",
        url: "http://test/checkout/cs_open_test",
        expires_at: new Date(Date.now() + 1800000).toISOString(),
        metadata: {},
      }).select("*");

      const res = await app.request("/checkout/cs_open_test");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(res.headers.get("content-type")).toContain("text/html");
      // Verify it contains checkout page elements
      expect(html).toContain("Checkout");
      expect(html).toContain("$10.00");
      expect(html).toContain("Starter");
      expect(html).toContain("walletAddress");
      expect(html).toContain("txHashInput");
      expect(html).toContain("submitBtn");
      expect(html).toContain("chainBadges");
    });
  });

  // ── Callback webhook ──

  describe("Callback webhook", () => {
    it("sends POST with HMAC signature when callbackUrl is provided", async () => {
      // Capture the global fetch calls
      const originalFetch = globalThis.fetch;
      const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
      globalThis.fetch = vi.fn(async (url: any, init?: any) => {
        fetchCalls.push({ url: String(url), init });
        return new Response("OK", { status: 200 });
      }) as any;

      mockedVerifyTransfer.mockResolvedValueOnce({
        from: "0xSender",
        to: "0xTestBaseWallet",
        amountRaw: "10000000",
        amountUsd: 10,
        token: "usdc",
        blockNumber: 12345,
        txHash: "0xcallback_tx",
      });

      const res = await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xcallback_tx",
          chainId: "base",
          token: "usdc",
          idType: "tg",
          uid: "42",
          plan: "starter",
          apiKey: "test-api-key",
          callbackUrl: "https://bot.example.com/webhook",
        }),
      });

      expect(res.status).toBe(200);

      // The callback is fired async (sendCallback().catch()), give it a tick
      await new Promise((r) => setTimeout(r, 100));

      // Find the callback fetch (not the /api/payment request itself)
      const callbackCall = fetchCalls.find(
        (c) => c.url === "https://bot.example.com/webhook",
      );
      expect(callbackCall).toBeDefined();
      expect(callbackCall!.init.method).toBe("POST");

      // Verify headers
      const headers = callbackCall!.init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["X-Signature"]).toBeDefined();
      expect(headers["X-Signature"]).toMatch(/^[a-f0-9]{64}$/); // SHA256 hex
      expect(headers["X-Timestamp"]).toBeDefined();
      expect(Number(headers["X-Timestamp"])).toBeGreaterThan(0);

      // Verify body
      const body = JSON.parse(callbackCall!.init.body as string);
      expect(body.event).toBe("payment.verified");
      expect(body.payment).toBeDefined();
      expect(body.payment.txHash).toBe("0xcallback_tx");
      expect(body.payment.chain).toBe("base");
      expect(body.payment.token).toBe("usdc");
      expect(body.payment.amountUsd).toBe(10);
      expect(body.payment.plan).toBe("starter");
      expect(body.payment.uid).toBe("42");
      expect(body.payment.idType).toBe("tg");
      expect(body.timestamp).toBeDefined();

      // Restore original fetch
      globalThis.fetch = originalFetch;
    });

    it("does NOT send callback when callbackUrl is not provided", async () => {
      const originalFetch = globalThis.fetch;
      const fetchCalls: Array<{ url: string }> = [];
      globalThis.fetch = vi.fn(async (url: any, init?: any) => {
        fetchCalls.push({ url: String(url) });
        return new Response("OK", { status: 200 });
      }) as any;

      mockedVerifyTransfer.mockResolvedValueOnce({
        from: "0xSender",
        to: "0xTestBaseWallet",
        amountRaw: "10000000",
        amountUsd: 10,
        token: "usdc",
        blockNumber: 12345,
        txHash: "0xno_callback_tx",
      });

      await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xno_callback_tx",
          chainId: "base",
          token: "usdc",
          idType: "tg",
          uid: "42",
          plan: "starter",
          apiKey: "test-api-key",
          // no callbackUrl
        }),
      });

      await new Promise((r) => setTimeout(r, 100));

      const webhookCalls = fetchCalls.filter(
        (c) => !c.url.includes("supabase"),
      );
      expect(webhookCalls.length).toBe(0);

      globalThis.fetch = originalFetch;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E FLOW: Link generation → Page load → Wallet UI verification
  // ═══════════════════════════════════════════════════════════════════════════

  describe("E2E: payment link → wallet connect flow", () => {
    // Simulates what OpenClawBot does: constructs a Mini App URL like
    // ${cryptoPaymentsUrl}/pay?plan=pro&uid=12345678&callback=https://bot.example.com/webhook
    // User opens the URL in Telegram → payment page loads with wallet integration

    it("loads payment page with correct plan/uid from query params", async () => {
      const url = "/pay?plan=pro&uid=12345678&callback=https%3A%2F%2Fbot.example.com%2Fwebhook";
      const res = await app.request(url);
      expect(res.status).toBe(200);
      const html = await res.text();

      // Page renders with the correct plan reference in the JS
      expect(html).toContain("Pay with Crypto");
      // The JS parses plan from query params: params.get('plan') || 'starter'
      // The HTML itself doesn't embed the plan server-side (it's parsed client-side)
      // So we verify the JS code that parses params is present
      expect(html).toContain("params.get('plan')");
      expect(html).toContain("params.get('uid')");
      expect(html).toContain("params.get('callback')");
    });

    it("payment page has all chain badges including Base Sepolia", async () => {
      const res = await app.request("/pay?plan=starter&uid=99");
      const html = await res.text();

      expect(html).toContain("data-chain=\"base\"");
      expect(html).toContain("data-chain=\"eth\"");
      expect(html).toContain("data-chain=\"sol\"");
      expect(html).toContain("data-chain=\"ton\"");
      expect(html).toContain("data-chain=\"base_sepolia\"");
    });

    it("payment page includes MetaMask wallet connect for EVM chains", async () => {
      const res = await app.request("/pay?plan=starter&uid=99");
      const html = await res.text();

      // ethers.js CDN loaded
      expect(html).toContain("ethers.umd.min.js");
      // MetaMask connect button
      expect(html).toContain("evmWalletBtn");
      expect(html).toContain("connectEvmWallet");
      // EVM chain IDs for wallet_switchEthereumChain
      expect(html).toContain("0x2105"); // Base
      expect(html).toContain("0x14a34"); // Base Sepolia
      // ERC-20 transfer ABI
      expect(html).toContain("function transfer(address to, uint256 amount)");
    });

    it("payment page includes Phantom wallet connect for Solana", async () => {
      const res = await app.request("/pay?plan=starter&uid=99");
      const html = await res.text();

      expect(html).toContain("solWalletBtn");
      expect(html).toContain("connectSolWallet");
      expect(html).toContain("phantom");
    });

    it("payment page includes TonConnect UI for TON", async () => {
      const res = await app.request("/pay?plan=starter&uid=99");
      const html = await res.text();

      // TonConnect CDN
      expect(html).toContain("tonconnect-ui");
      // TonConnect button container
      expect(html).toContain("ton-connect-button");
      expect(html).toContain("tonWalletBtnContainer");
      // TonConnect manifest URL
      expect(html).toContain("tonconnect-manifest.json");
    });

    it("payment page has wallet send button and or-divider for manual fallback", async () => {
      const res = await app.request("/pay?plan=starter&uid=99");
      const html = await res.text();

      // "Send Payment via Wallet" button
      expect(html).toContain("sendTxBtn");
      expect(html).toContain("sendWalletTx");
      expect(html).toContain("Send Payment via Wallet");
      // "or" divider between wallet and manual flow
      expect(html).toContain("orDivider");
      // Manual fallback still present
      expect(html).toContain("walletAddress");
      expect(html).toContain("txHashInput");
      expect(html).toContain("Paste your transaction hash");
    });

    it("config endpoint returns token addresses used by wallet connect", async () => {
      const res = await app.request("/api/config");
      expect(res.status).toBe(200);
      const body = await res.json();

      // Wallet addresses for each chain
      expect(body.wallets.base).toBe("0xTestBaseWallet");
      expect(body.wallets.eth).toBe("0xTestEthWallet");
      expect(body.wallets.ton).toBe("EQTestTonWallet");
      expect(body.wallets.sol).toBe("TestSolWallet");

      // Token contract addresses the JS uses for ERC-20 transfer()
      expect(body.tokens.base.usdc).toBeTruthy();
      expect(body.tokens.base.usdt).toBeTruthy();
      expect(body.tokens.eth.usdc).toBeTruthy();
      expect(body.tokens.sol.usdc).toBeTruthy();
      expect(body.tokens.ton.usdc).toBeTruthy();
      expect(body.tokens.base_sepolia.usdc).toBeTruthy();

      // Prices for plan matching
      expect(body.prices.starter).toBe(10);
      expect(body.prices.pro).toBe(25);
      expect(body.prices.max).toBe(100);
    });

    it("checkout page also has wallet connect UI when session is open", async () => {
      // Create a checkout session first (amount in cents)
      const createRes = await app.request("/v1/checkout/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "test-api-key",
        },
        body: JSON.stringify({
          amount: 1000,
          plan_id: "starter",
        }),
      });
      expect(createRes.status).toBe(200);
      const session = await createRes.json();

      // Load the checkout page
      const checkoutRes = await app.request(`/checkout/${session.id}`);
      expect(checkoutRes.status).toBe(200);
      const html = await checkoutRes.text();

      // Checkout page should also have wallet integration
      expect(html).toContain("ethers.umd.min.js");
      expect(html).toContain("tonconnect-ui");
      expect(html).toContain("evmWalletBtn");
      expect(html).toContain("solWalletBtn");
      expect(html).toContain("ton-connect-button");
      expect(html).toContain("sendTxBtn");
    });
  });
});
