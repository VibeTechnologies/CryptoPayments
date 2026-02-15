import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { unlinkSync } from "node:fs";

// We need to set env vars BEFORE importing server.ts (which calls loadConfig at top level)
const TEST_DB = "./data/test-server.db";
process.env.DATABASE_URL = TEST_DB;
process.env.API_KEY = "test-api-key";
process.env.CALLBACK_SECRET = "test-callback-secret";
process.env.TELEGRAM_BOT_TOKEN = "123456:TestBotToken";
process.env.WALLET_BASE = "0xTestBaseWallet";
process.env.WALLET_ETH = "0xTestEthWallet";
process.env.WALLET_TON = "EQTestTonWallet";
process.env.WALLET_SOL = "TestSolWallet";
process.env.PORT = "0"; // Don't actually listen

// Mock @hono/node-server to prevent the server from actually starting
vi.mock("@hono/node-server", () => ({
  serve: vi.fn(),
}));

vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => async (_c: any, next: any) => next(),
}));

// Mock verify to avoid real RPC calls
vi.mock("../src/verify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verify.js")>();
  return {
    ...actual,
    verifyTransfer: vi.fn(),
  };
});

// Now import after env + mocks are set
const { app } = await import("../src/server.js");
const { verifyTransfer } = await import("../src/verify.js");
const mockedVerifyTransfer = vi.mocked(verifyTransfer);

describe("Server API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
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
      expect(body.chains).toEqual(["base", "eth", "ton", "sol"]);
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
    });

    it("returns 409 for duplicate tx submission", async () => {
      // The tx "0xvalidtx1" was already submitted in previous test
      const res = await app.request("/api/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: "0xvalidtx1",
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
      const res = await app.request("/api/payment/1");
      expect(res.status).toBe(401);
    });

    it("returns payment by ID with valid API key", async () => {
      const res = await app.request("/api/payment/1?api_key=test-api-key");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.payment).toBeDefined();
      expect(body.payment.id).toBe(1);
    });

    it("returns 404 for non-existent payment", async () => {
      const res = await app.request("/api/payment/99999?api_key=test-api-key");
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
      const res = await app.request(
        "/api/payments?idtype=tg&uid=42&api_key=test-api-key",
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.payments).toBeDefined();
      expect(Array.isArray(body.payments)).toBe(true);
      // We submitted several payments for uid=42 in earlier tests
      expect(body.payments.length).toBeGreaterThanOrEqual(1);
    });
  });
});
