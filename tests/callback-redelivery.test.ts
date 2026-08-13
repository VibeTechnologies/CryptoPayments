/**
 * Callback REDELIVERY (CryptoPayments#46).
 *
 * The hole this closes: `recordCallbackOutcome` only LOGGED the delivery
 * result. A consumer that returned 5xx, or was down for thirty seconds during a
 * deploy, meant the payment was verified on-chain, the money was in our wallet,
 * and the customer was never credited — permanently, silently, with no retry.
 *
 * These tests pin the whole policy: what is retried, what is NOT, when, when it
 * stops, and — critically — that a REDELIVERED payload still satisfies the
 * consumer's freshness rule while keeping the txHash the consumer dedupes on.
 *
 * No wall-clock sleeps anywhere: time is injected (`nowMs` / `vi.setSystemTime`)
 * so backoff is asserted as arithmetic and ordering, not as flakiness.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DB } from "../src/db.js";
import { createMockSupabase } from "./helpers/mock-db.js";
import {
  backoffMs,
  computeNextState,
  isDue,
  isRetryable,
  buildSignedPayload,
  passesConsumerFreshness,
  assertRedeliverySafe,
  CONSUMER_TIMESTAMP_WINDOW_SEC,
  DEFAULT_RETRY_POLICY,
} from "../src/callback-delivery.js";

// ── Env must be set BEFORE importing server.ts ───────────────────────────────
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.API_KEY = "test-api-key";
process.env.CALLBACK_SECRET = "test-callback-secret";
process.env.CHECKOUT_SECRET = "test-callback-secret";
process.env.TELEGRAM_BOT_TOKEN = "123456:TestBotToken";
process.env.WALLET_BASE = "0xTestBaseWallet";
process.env.WALLET_ETH = "0xTestEthWallet";
process.env.WALLET_TON = "EQTestTonWallet";
process.env.WALLET_SOL = "TestSolWallet";
process.env.PORT = "0";

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => async (_c: any, next: any) => next(),
}));
vi.mock("../src/verify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verify.js")>();
  return { ...actual, verifyTransfer: vi.fn() };
});

const { createApp } = await import("../src/server.js");
const { verifyTransfer } = await import("../src/verify.js");
const { getCallbackState } = await import("../src/db.js");
const mockedVerifyTransfer = vi.mocked(verifyTransfer);

const CALLBACK_URL = "https://admin.openclaw.vibebrowser.app/webhook";
const TX = "0xredelivery_tx";

// ═════════════════════════════════════════════════════════════════════════════
// Policy — pure, no I/O
// ═════════════════════════════════════════════════════════════════════════════

describe("retry classification", () => {
  it("retries 5xx — the consumer is broken, not the payload", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isRetryable({ ok: false, status, error: "x" }), `status ${status}`).toBe(true);
    }
  });

  it("retries a network error / timeout — the consumer never saw the payload", () => {
    expect(isRetryable({ ok: false, error: "network error: ECONNREFUSED" })).toBe(true);
  });

  it("retries 408 and 429 — explicitly try-again-later semantics", () => {
    expect(isRetryable({ ok: false, status: 408, error: "x" })).toBe(true);
    expect(isRetryable({ ok: false, status: 429, error: "x" })).toBe(true);
  });

  it("does NOT retry other 4xx — identical bytes can only be rejected again", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryable({ ok: false, status, error: "x" }), `status ${status}`).toBe(false);
    }
  });

  it("does NOT retry a structurally undeliverable target (non-allowlisted host)", () => {
    expect(isRetryable({ ok: false, error: "not allowlisted", permanent: true })).toBe(false);
  });
});

describe("backoff", () => {
  it("grows exponentially and then caps", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffMs(n));
    // Strictly increasing until the cap, never decreasing after.
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }
    expect(delays[0]).toBe(DEFAULT_RETRY_POLICY.baseDelayMs);
    expect(delays[1]).toBe(DEFAULT_RETRY_POLICY.baseDelayMs * 2);
    expect(Math.max(...delays)).toBeLessThanOrEqual(DEFAULT_RETRY_POLICY.maxDelayMs);
  });

  it("schedules next_attempt_at exactly one backoff into the future", () => {
    const t0 = 1_700_000_000_000;
    const s1 = computeNextState(null, CALLBACK_URL, { ok: false, status: 503, error: "x" }, t0);
    expect(s1.status).toBe("pending");
    expect(s1.attempts).toBe(1);
    expect(Date.parse(s1.next_attempt_at!)).toBe(t0 + backoffMs(1));

    const s2 = computeNextState(s1, CALLBACK_URL, { ok: false, status: 503, error: "x" }, t0 + 60_000);
    expect(s2.attempts).toBe(2);
    expect(Date.parse(s2.next_attempt_at!)).toBe(t0 + 60_000 + backoffMs(2));
    // Second gap is strictly larger than the first — that IS the backoff.
    expect(backoffMs(2)).toBeGreaterThan(backoffMs(1));
  });

  it("is not due before next_attempt_at, and is due after", () => {
    const t0 = 1_700_000_000_000;
    const s = computeNextState(null, CALLBACK_URL, { ok: false, status: 503, error: "x" }, t0);
    expect(isDue(s, t0 + backoffMs(1) - 1)).toBe(false);
    expect(isDue(s, t0 + backoffMs(1))).toBe(true);
  });

  it("gives up after maxAttempts and goes terminal needs_attention", () => {
    const t0 = 1_700_000_000_000;
    let state = computeNextState(null, CALLBACK_URL, { ok: false, status: 503, error: "down" }, t0);
    for (let i = 2; i <= DEFAULT_RETRY_POLICY.maxAttempts; i++) {
      state = computeNextState(state, CALLBACK_URL, { ok: false, status: 503, error: "down" }, t0 + i * 1000);
    }
    expect(state.attempts).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
    expect(state.status).toBe("needs_attention");
    expect(state.terminal_reason).toBe("retries_exhausted");
    expect(isDue(state, t0 + 10 ** 9)).toBe(false);
  });

  it("a delivered state is terminal and never due again", () => {
    const t0 = 1_700_000_000_000;
    const ok = computeNextState(null, CALLBACK_URL, { ok: true }, t0);
    expect(ok.status).toBe("delivered");
    expect(ok.next_attempt_at).toBeNull();
    expect(isDue(ok, t0 + 10 ** 9)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The consumer's freshness rule — encoded here ON PURPOSE
// ═════════════════════════════════════════════════════════════════════════════

describe("consumer freshness contract", () => {
  /**
   * This mirrors `subscriptions/lib/crypto-callback.cjs` (platform PR #77) and
   * OpenClawBot's `crypto-webhook.ts`: freshness is judged from the SIGNED
   * `payload.timestamp` in the BODY, with a ±300s window. The `x-timestamp`
   * header is NOT covered by the HMAC and cannot refresh a stale body.
   *
   * If the consumer ever changes this rule, THIS test is what breaks — which is
   * the point. Do not relax it; fix the producer.
   */
  function consumerAccepts(rawBody: string, receivedAtMs: number): boolean {
    const parsed = JSON.parse(rawBody);
    const ts = Number(parsed.timestamp);
    if (!Number.isFinite(ts)) return false;
    return Math.abs(Math.floor(receivedAtMs / 1000) - ts) <= 300;
  }

  it("mirrors our own helper — the window is 300s on either side", () => {
    expect(CONSUMER_TIMESTAMP_WINDOW_SEC).toBe(300);
    const t0 = 1_700_000_000_000;
    const { payload } = buildSignedPayload(
      { event: "payment.verified", payment: { txHash: TX } },
      t0,
    );
    expect(consumerAccepts(payload, t0)).toBe(passesConsumerFreshness(JSON.parse(payload).timestamp, t0));
  });

  it("REJECTS a byte-identical replay of the original body 10 minutes later", () => {
    // This is exactly why we re-sign instead of replaying the original bytes.
    const t0 = 1_700_000_000_000;
    const { payload } = buildSignedPayload(
      { event: "payment.verified", payment: { txHash: TX } },
      t0,
    );
    expect(consumerAccepts(payload, t0)).toBe(true);
    expect(consumerAccepts(payload, t0 + 10 * 60_000)).toBe(false);
  });

  it("ACCEPTS a redelivery re-signed with a fresh timestamp, same txHash", () => {
    const t0 = 1_700_000_000_000;
    const body = { event: "payment.verified" as const, payment: { txHash: TX, uid: "42" } };
    const first = buildSignedPayload(body, t0);
    const redelivered = buildSignedPayload(body, t0 + 47 * 60_000);

    expect(consumerAccepts(redelivered.payload, t0 + 47 * 60_000)).toBe(true);

    const safety = assertRedeliverySafe(first.payload, redelivered.payload, t0 + 47 * 60_000);
    expect(safety.fresh).toBe(true);
    // Exactly-once rests entirely on this: the consumer dedupes on txHash, so a
    // second SUCCESSFUL delivery credits nothing.
    expect(safety.sameTxHash).toBe(true);
  });

  it("changes ONLY the timestamp between attempts — every other byte is identical", () => {
    const t0 = 1_700_000_000_000;
    const body = {
      event: "payment.verified" as const,
      payment: { txHash: TX, uid: "42", plan: "starter", amountUsd: 10, product: "openclaw" },
    };
    const a = JSON.parse(buildSignedPayload(body, t0).payload);
    const b = JSON.parse(buildSignedPayload(body, t0 + 600_000).payload);
    expect(a.timestamp).not.toBe(b.timestamp);
    delete a.timestamp;
    delete b.timestamp;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// End-to-end through the app: verify -> fail -> redeliver
// ═════════════════════════════════════════════════════════════════════════════

describe("redelivery through the running app", () => {
  let mockDb: DB;
  let app: ReturnType<typeof createApp>;
  let realFetch: typeof globalThis.fetch;
  let callbackPosts: Array<{ body: string; atMs: number }>;
  /** Statuses the fake consumer returns, consumed one per attempt. */
  let consumerStatuses: number[];

  const T0 = 1_700_000_000_000;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);

    mockDb = createMockSupabase();
    app = createApp(mockDb);
    realFetch = globalThis.fetch;
    callbackPosts = [];
    consumerStatuses = [];

    globalThis.fetch = vi.fn(async (url: any, init?: any) => {
      if (String(url) === CALLBACK_URL) {
        callbackPosts.push({ body: String(init?.body), atMs: Date.now() });
        const status = consumerStatuses.shift() ?? 200;
        return new Response(status === 200 ? "OK" : "nope", { status });
      }
      return new Response("OK", { status: 200 });
    }) as any;

    mockedVerifyTransfer.mockResolvedValue({
      verified: true,
      from: "0xsender",
      to: "0xTestBaseWallet",
      amountRaw: "10000000",
      amountUsd: 10,
      token: "usdc",
      blockNumber: 1,
      txHash: TX,
    } as any);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function pay(txHash = TX): Promise<string> {
    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash,
        chainId: "base",
        token: "usdc",
        idType: "tg",
        uid: "42",
        plan: "starter",
        apiKey: "test-api-key",
        callbackUrl: CALLBACK_URL,
      }),
    });
    expect(res.status).toBe(200);
    return (await res.json()).payment.id;
  }

  /** Force a redelivery sweep at a specific simulated time. */
  async function drainAt(ms: number): Promise<any> {
    vi.setSystemTime(ms);
    const res = await app.request("/api/admin/callbacks/redeliver", {
      method: "POST",
      headers: { "x-api-key": "test-api-key" },
    });
    expect(res.status).toBe(200);
    return await res.json();
  }

  it("retryable 5xx is retried and eventually delivered with the SAME txHash", async () => {
    consumerStatuses = [503, 503, 200];
    const id = await pay();

    // First attempt failed; state is pending with a scheduled retry.
    let state = await getCallbackState(mockDb, id);
    expect(state?.status).toBe("pending");
    expect(state?.attempts).toBe(1);
    expect(state?.last_status).toBe(503);

    // Too early — the backoff is respected, no extra POST happens.
    const before = callbackPosts.length;
    await drainAt(T0 + backoffMs(1) - 1000);
    expect(callbackPosts.length).toBe(before);

    // Due: second attempt (also 503), then a third that succeeds.
    await drainAt(T0 + backoffMs(1));
    state = await getCallbackState(mockDb, id);
    expect(state?.attempts).toBe(2);
    expect(state?.status).toBe("pending");

    const t3 = T0 + backoffMs(1) + backoffMs(2);
    await drainAt(t3);

    state = await getCallbackState(mockDb, id);
    expect(state?.status).toBe("delivered");
    expect(state?.attempts).toBe(3);
    expect(state?.delivered_at).toBeTruthy();

    // Three POSTs, all carrying the identical txHash the consumer dedupes on.
    expect(callbackPosts).toHaveLength(3);
    const hashes = callbackPosts.map((p) => JSON.parse(p.body).payment.txHash);
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toBe(TX);

    // Attempt gaps are non-decreasing — backoff, asserted as ordering.
    const gaps = callbackPosts.slice(1).map((p, i) => p.atMs - callbackPosts[i].atMs);
    expect(gaps[1]).toBeGreaterThanOrEqual(gaps[0]);

    // ...and the LAST redelivery is still fresh enough for the consumer.
    const last = JSON.parse(callbackPosts[2].body);
    expect(passesConsumerFreshness(last.timestamp, t3)).toBe(true);
  });

  it("non-retryable 4xx goes terminal needs_attention, is not retried, and alerts", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.join(" "));
    });

    consumerStatuses = [400];
    const id = await pay();

    const state = await getCallbackState(mockDb, id);
    expect(state?.status).toBe("needs_attention");
    expect(state?.attempts).toBe(1);
    expect(state?.terminal_reason).toBe("non_retryable_400");

    // A loud, greppable alert carrying the txHash so an operator can find the
    // stuck money on-chain and in the consumer's DB.
    const alert = errors.find((e) => e.includes("[PAYMENT-STUCK]"));
    expect(alert).toBeDefined();
    expect(alert).toContain(TX);
    expect(alert).toContain("non_retryable_400");

    // Never retried again, no matter how far in the future we sweep.
    const posts = callbackPosts.length;
    await drainAt(T0 + 24 * 3600_000);
    expect(callbackPosts.length).toBe(posts);

    spy.mockRestore();
  });

  it("redelivery after a successful delivery is a no-op", async () => {
    consumerStatuses = [200];
    const id = await pay();

    expect((await getCallbackState(mockDb, id))?.status).toBe("delivered");
    expect(callbackPosts).toHaveLength(1);

    const result = await drainAt(T0 + 3600_000);
    expect(result.attempted).toBe(0);
    // The consumer is never POSTed twice for an already-delivered payment.
    expect(callbackPosts).toHaveLength(1);
  });

  it("exposes stuck payments to an operator", async () => {
    consumerStatuses = [503];
    const id = await pay();

    const res = await app.request("/api/admin/callbacks/stuck", {
      headers: { "x-api-key": "test-api-key" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.stuck[0].paymentId).toBe(id);
    expect(body.stuck[0].txHash).toBe(TX);
    expect(body.stuck[0].status).toBe("pending");
  });

  it("requires the API key for the admin redelivery endpoints", async () => {
    for (const path of ["/api/admin/callbacks/stuck", "/api/admin/callbacks/redeliver"]) {
      const res = await app.request(path, { method: path.endsWith("redeliver") ? "POST" : "GET" });
      expect(res.status, path).toBe(401);
    }
  });

  it("redelivers OPPORTUNISTICALLY on an ordinary request — the real prod trigger", async () => {
    // This is the mechanism that actually runs in production. A Supabase Edge
    // Function is request-scoped, so nothing retries on a timer; the next
    // inbound request is the scheduler. If this ever regresses, redelivery
    // silently stops working even though the admin endpoint still passes.
    consumerStatuses = [503, 200];
    const id = await pay();
    expect((await getCallbackState(mockDb, id))?.status).toBe("pending");
    expect(callbackPosts).toHaveLength(1);

    // An unrelated, unauthenticated request, once the retry is due.
    vi.setSystemTime(T0 + backoffMs(1));
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    // The drain is fire-and-forget behind the response; let the microtasks run.
    await vi.waitFor(async () => {
      expect((await getCallbackState(mockDb, id))?.status).toBe("delivered");
    });

    expect(callbackPosts).toHaveLength(2);
    expect(JSON.parse(callbackPosts[1].body).payment.txHash).toBe(TX);
  });
});
