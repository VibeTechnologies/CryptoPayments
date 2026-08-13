import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { createMockSupabase } from "./helpers/mock-db.js";

// ── Env MUST be set before importing server.ts ───────────────────────────────
//
// Two products with DELIBERATELY different price tables, so a plan can only be
// resolved correctly if the lookup is scoped to the paying product:
//
//   openclaw: starter 10 / pro 25 / max 100   (the historical, flat defaults)
//   vibe:     starter 12 / pro 30 / max 120
//
// $12 is `starter` for vibe and NOTHING for openclaw; $10 is `starter` for
// openclaw and NOTHING for vibe. A product-blind resolver cannot pass both.
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.API_KEY = "test-api-key";
process.env.CALLBACK_SECRET = "test-callback-secret";
process.env.CHECKOUT_SECRET = "test-callback-secret";
process.env.WALLET_BASE = "0xTestBaseWallet";
process.env.WALLET_ETH = "0xTestEthWallet";
process.env.WALLET_TON = "EQTestTonWallet";
process.env.WALLET_SOL = "TestSolWallet";
process.env.PRODUCTS = "openclaw,vibe";
process.env.PRICE_STARTER_VIBE = "12";
process.env.PRICE_PRO_VIBE = "30";
process.env.PRICE_MAX_VIBE = "120";
process.env.WALLET_BASE_VIBE = "0xVibeBaseWallet";
process.env.PRODUCT_NAME_VIBE = "Vibe Browser";
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
const { loadConfig, productConfig, configForProduct, DEFAULT_PRODUCT } = await import(
  "../src/config.js"
);
const { resolveplan } = await import("../src/verify.js");
const { insertPayment } = await import("../src/db.js");
const mockedVerifyTransfer = vi.mocked(verifyTransfer);

/**
 * Reference implementation of the CURRENT canonical signing string, written out
 * longhand rather than reusing the server's builder — a test that calls the
 * code under test to compute the expected value proves nothing.
 *
 * Length-prefixed on both key and value: `<kLen>:<k>=<vLen>:<v>` joined by "\n".
 */
function signIntent(params: Record<string, string>): string {
  const canonical = [...new URLSearchParams(params).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k.length}:${k}=${v.length}:${v}`)
    .join("\n");
  return createHmac("sha256", "test-callback-secret").update(canonical).digest("hex");
}

/**
 * Reference implementation of the LEGACY (pre-length-prefix) canonical string,
 * still in production use by OpenClawBot. Kept so backward compatibility is
 * tested against the real old algorithm.
 */
function signIntentLegacy(params: Record<string, string>): string {
  const canonical = [...new URLSearchParams(params).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  return createHmac("sha256", "test-callback-secret").update(canonical).digest("hex");
}

let app: ReturnType<typeof createApp>;
let mockDb: ReturnType<typeof createMockSupabase>;
beforeEach(() => {
  // mockReset (not clearAllMocks) — clearAllMocks leaves any unconsumed
  // mockResolvedValueOnce queued, which leaks a stale on-chain result into the
  // next test.
  mockedVerifyTransfer.mockReset();
  mockDb = createMockSupabase();
  app = createApp(mockDb);
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = vi.fn(async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    return new Response("OK", { status: 200 });
  }) as any;
  return calls;
}

// ═══════════════════════════════════════════════════════════════════════════
// (a) `product` is inside the HMAC — tampering invalidates the signature
// ═══════════════════════════════════════════════════════════════════════════

describe("product is covered by the checkout-intent signature", () => {
  const exp = () => String(Math.floor(Date.now() / 1000) + 1800);

  it("rejects an intent whose product was swapped after signing", async () => {
    // Signed honestly for vibe at vibe's starter price ($12)...
    const expTs = exp();
    const signed = {
      uid: "42",
      idtype: "tg",
      plan: "starter",
      amountUsd: "12.00",
      product: "vibe",
      exp: expTs,
    };
    const sig = signIntent(signed);

    // ...then the attacker swaps to openclaw, where $12 buys nothing but the
    // request would otherwise be authenticated.
    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xtampered",
        chainId: "base",
        token: "usdc",
        idType: "tg",
        uid: "42",
        plan: "starter",
        amountUsd: "12.00",
        product: "openclaw", // ← tampered
        exp: expTs,
        sig,
      }),
    });

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Authentication required");
    // Never even reached chain verification.
    expect(mockedVerifyTransfer).not.toHaveBeenCalled();
  });

  it("rejects an intent where product is stripped after signing", async () => {
    const expTs = exp();
    const sig = signIntent({
      uid: "42",
      idtype: "tg",
      plan: "starter",
      amountUsd: "12.00",
      product: "vibe",
      exp: expTs,
    });

    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xstripped",
        chainId: "base",
        token: "usdc",
        idType: "tg",
        uid: "42",
        plan: "starter",
        amountUsd: "12.00",
        // product removed entirely => would silently mean "openclaw"
        exp: expTs,
        sig,
      }),
    });

    expect(res.status).toBe(401);
  });

  it("accepts an intent whose product matches the signature", async () => {
    const expTs = exp();
    const signed = {
      uid: "42",
      idtype: "tg",
      plan: "starter",
      amountUsd: "12.00",
      product: "vibe",
      exp: expTs,
    };
    mockedVerifyTransfer.mockResolvedValueOnce({
      from: "0xSender",
      to: "0xVibeBaseWallet",
      amountRaw: "12000000",
      amountUsd: 12,
      token: "usdc",
      blockNumber: 1,
      txHash: "0xhonest",
    } as any);

    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xhonest",
        chainId: "base",
        token: "usdc",
        idType: "tg",
        ...signed,
        uid: "42",
        sig: signIntent(signed),
      }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).payment.plan_id).toBe("starter");

    // The on-chain check MUST have been scoped to vibe's receiving wallet.
    // Without this assertion the test was vacuous: `verifyTransfer` is mocked,
    // so deleting `configForProduct` from the POST path still left it green.
    expect(mockedVerifyTransfer).toHaveBeenCalledTimes(1);
    const [, , scopedConfig] = mockedVerifyTransfer.mock.calls[0] as any[];
    expect(scopedConfig.wallets.base).toBe("0xVibeBaseWallet");
    expect(scopedConfig.prices.starter).toBe(12);
  });

  it("rejects an unknown product outright rather than falling back to openclaw", async () => {
    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xunknownproduct",
        chainId: "base",
        token: "usdc",
        idType: "tg",
        uid: "42",
        plan: "starter",
        product: "not-a-product",
        apiKey: "test-api-key",
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown product/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (b) Backward compatibility: absent `product` == today's behaviour
// ═══════════════════════════════════════════════════════════════════════════

describe("backward compatibility — an intent with no product", () => {
  it("validates against the pre-multi-product canonical string", async () => {
    // Byte-for-byte the canonical string OpenClawBot signs today (docs/crypto.md):
    //   amountUsd / callback / exp / hostType / idtype / plan / uid
    const expTs = String(Math.floor(Date.now() / 1000) + 1800);
    const legacy = {
      amountUsd: "10.00",
      callback: "https://admin.openclaw.agentlabs.cc/crypto/webhook",
      exp: expTs,
      hostType: "vps",
      idtype: "tg",
      plan: "starter",
      uid: "42",
    };
    const sig = signIntent(legacy);

    mockedVerifyTransfer.mockResolvedValueOnce({
      from: "0xSender",
      to: "0xTestBaseWallet",
      amountRaw: "10000000",
      amountUsd: 10,
      token: "usdc",
      blockNumber: 1,
      txHash: "0xlegacy",
    } as any);

    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xlegacy",
        chainId: "base",
        token: "usdc",
        idType: "tg",
        uid: "42",
        plan: "starter",
        amountUsd: "10.00",
        hostType: "vps",
        callbackUrl: "https://admin.openclaw.agentlabs.cc/crypto/webhook",
        exp: expTs,
        sig,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payment.plan_id).toBe("starter");
  });

  it("uses openclaw prices, wallets and allowlist when product is absent", () => {
    const config = loadConfig();
    const dflt = productConfig(config, undefined);
    expect(dflt.id).toBe(DEFAULT_PRODUCT);
    expect(dflt.prices).toEqual({ starter: 10, pro: 25, max: 100 });
    expect(dflt.topupPrices).toEqual({ small: 5, medium: 10, large: 25 });
    expect(dflt.wallets.base).toBe("0xTestBaseWallet");
    expect(dflt.callbackAllowlist).toEqual(config.callbackAllowlist);
    // Flat, pre-existing top-level fields are unchanged.
    expect(config.prices).toEqual({ starter: 10, pro: 25, max: 100 });
    expect(config.wallets.base).toBe("0xTestBaseWallet");
  });

  it("verifies against the openclaw wallet when product is absent", async () => {
    mockedVerifyTransfer.mockResolvedValueOnce({
      from: "0xSender",
      to: "0xTestBaseWallet",
      amountRaw: "25000000",
      amountUsd: 25,
      token: "usdc",
      blockNumber: 1,
      txHash: "0xnoproduct",
    } as any);

    await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xnoproduct",
        chainId: "base",
        token: "usdc",
        idType: "tg",
        uid: "42",
        plan: "pro",
        apiKey: "test-api-key",
      }),
    });

    const passedConfig = mockedVerifyTransfer.mock.calls[0][2] as any;
    expect(passedConfig.wallets.base).toBe("0xTestBaseWallet");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (c) Two products with different price tables resolve plans independently
// ═══════════════════════════════════════════════════════════════════════════

describe("per-product plan resolution", () => {
  const config = loadConfig();

  it("resolves the same amount to different plans per product", () => {
    expect(resolveplan(10, config, "openclaw")).toBe("starter");
    expect(resolveplan(10, config, "vibe")).toBeNull();
    expect(resolveplan(12, config, "vibe")).toBe("starter");
    expect(resolveplan(12, config, "openclaw")).toBeNull();
    expect(resolveplan(30, config, "vibe")).toBe("pro");
    expect(resolveplan(25, config, "openclaw")).toBe("pro");
    expect(resolveplan(120, config, "vibe")).toBe("max");
  });

  it("treats an ABSENT product as openclaw (legacy shape)", () => {
    expect(resolveplan(10, config)).toBe("starter");
    expect(resolveplan(10, config, undefined)).toBe("starter");
    expect(resolveplan(10, config, "")).toBe("starter");
  });

  it("THROWS on an unknown product rather than pricing it as openclaw", () => {
    // Silently falling back meant that removing a product from PRODUCTS while
    // payments were pending re-priced them against openclaw's table.
    expect(() => resolveplan(10, config, "nope")).toThrow(/Unknown product: nope/);
  });

  it("still accepts a bare price table (legacy call shape)", () => {
    expect(resolveplan(25, { starter: 10, pro: 25, max: 100 })).toBe("pro");
  });

  it("rejects a vibe payment paid at openclaw's price", async () => {
    mockedVerifyTransfer.mockResolvedValueOnce({
      from: "0xSender",
      to: "0xVibeBaseWallet",
      amountRaw: "10000000",
      amountUsd: 10, // openclaw's starter price, not vibe's
      token: "usdc",
      blockNumber: 1,
      txHash: "0xunderpaid_vibe",
    } as any);

    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xunderpaid_vibe",
        chainId: "base",
        token: "usdc",
        idType: "tg",
        uid: "42",
        plan: "starter",
        product: "vibe",
        apiKey: "test-api-key",
      }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not match/);
  });

  it("scopes the receiving wallet to the product, with fallback to the global one", () => {
    expect(configForProduct(config, "vibe").wallets.base).toBe("0xVibeBaseWallet");
    // vibe has no ETH override → shares the global wallet (shared wallet stays possible)
    expect(configForProduct(config, "vibe").wallets.eth).toBe("0xTestEthWallet");
    expect(configForProduct(config, "openclaw").wallets.base).toBe("0xTestBaseWallet");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (d) Callback payload carries `product`
// ═══════════════════════════════════════════════════════════════════════════

describe("callback payload", () => {
  async function payAndCaptureCallback(extra: Record<string, unknown>, amountUsd: number) {
    const calls = captureFetch();
    mockedVerifyTransfer.mockResolvedValueOnce({
      from: "0xSender",
      to: "0xTestBaseWallet",
      amountRaw: String(amountUsd * 1e6),
      amountUsd,
      token: "usdc",
      blockNumber: 1,
      txHash: String(extra.txHash),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: "base",
        token: "usdc",
        idType: "tg",
        uid: "42",
        apiKey: "test-api-key",
        callbackUrl: "https://admin.openclaw.agentlabs.cc/crypto/webhook",
        ...extra,
      }),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    // Match on the tx hash, not just the host: sendCallback is fire-and-forget,
    // so a previous test's callback can land in this capture array.
    const cb = calls
      .filter((c) => c.url.startsWith("https://admin.openclaw.agentlabs.cc"))
      .map((c) => JSON.parse(c.init.body as string))
      .find((b) => b.payment?.txHash === extra.txHash);
    expect(cb).toBeDefined();
    return cb;
  }

  it("includes product: openclaw for a legacy payment with no product field", async () => {
    const body = await payAndCaptureCallback(
      { txHash: "0xcb_legacy", plan: "starter", hostType: "vps", tenantType: "team" },
      10,
    );
    expect(body.payment.product).toBe("openclaw");
    // Every pre-existing field the OpenClawBot consumer reads is still there.
    expect(body.event).toBe("payment.verified");
    expect(body.payment.id).toBeDefined();
    expect(body.payment.idType).toBe("tg");
    expect(body.payment.uid).toBe("42");
    expect(body.payment.plan).toBe("starter");
    expect(body.payment.chain).toBe("base");
    expect(body.payment.token).toBe("usdc");
    expect(body.payment.amountUsd).toBe(10);
    expect(body.payment.txHash).toBe("0xcb_legacy");
    expect(body.payment.hostType).toBe("vps");
    expect(body.payment.tenantType).toBe("team");
    expect(body.timestamp).toBeDefined();
  });

  it("includes the explicit product for a second-product payment", async () => {
    const body = await payAndCaptureCallback(
      { txHash: "0xcb_vibe", plan: "starter", product: "vibe" },
      12,
    );
    expect(body.payment.product).toBe("vibe");
    expect(body.payment.plan).toBe("starter");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Branding + /api/config
// ═══════════════════════════════════════════════════════════════════════════

describe("branding and public config", () => {
  it("scopes /api/config to the requested product", async () => {
    const dflt = await (await app.request("/api/config")).json();
    expect(dflt.product).toBe("openclaw");
    expect(dflt.prices).toEqual({ starter: 10, pro: 25, max: 100 });
    expect(dflt.wallets.base).toBe("0xTestBaseWallet");

    const vibe = await (await app.request("/api/config?product=vibe")).json();
    expect(vibe.product).toBe("vibe");
    expect(vibe.productName).toBe("Vibe Browser");
    expect(vibe.prices).toEqual({ starter: 12, pro: 30, max: 120 });
    expect(vibe.wallets.base).toBe("0xVibeBaseWallet");
  });

  it("resolves the TonConnect manifest name/icon from the product config", async () => {
    const dflt = await (await app.request("/tonconnect-manifest.json")).json();
    expect(dflt.name).toBe("OpenClaw Crypto Payments");
    expect(dflt.iconUrl).toBe("https://openclaw.ai/favicon.ico");

    const vibe = await (await app.request("/tonconnect-manifest.json?product=vibe")).json();
    expect(vibe.name).toBe("Vibe Browser");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (e) Canonical-string integrity: no value may forge a field boundary
// ═══════════════════════════════════════════════════════════════════════════

describe("canonical string is not forgeable by separator injection", () => {
  const exp = () => String(Math.floor(Date.now() / 1000) + 1800);

  /**
   * The original bug. `URLSearchParams.entries()` returns DECODED values, so a
   * raw "\n" inside `plan` passed straight through the old `k=v` join and
   *
   *     {plan: "starter\nproduct=vibe"}   ->  "plan=starter\nproduct=vibe"
   *
   * is byte-identical to the canonical string of
   *
   *     {plan: "starter", product: "vibe"}
   *
   * because `plan` sorts immediately before `product`. An attacker who could
   * obtain a signature over the innocuous-looking single-field intent could
   * replay it as a two-field intent that forges `product` — which selects the
   * receiving wallet, the price table and the callback allowlist.
   */
  it("does not let a newline in a value forge an extra field (new format)", async () => {
    const expTs = exp();
    // Signed over ONE field whose value happens to contain a newline.
    const injected = {
      uid: "42",
      idtype: "tg",
      plan: "starter\nproduct=vibe",
      amountUsd: "12.00",
      exp: expTs,
    };
    const sig = signIntent(injected);

    // Replayed as if it were TWO clean fields {plan: starter, product: vibe}.
    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xinject1",
        chainId: "base",
        token: "usdc",
        idType: "tg",
        uid: "42",
        plan: "starter",
        product: "vibe",
        amountUsd: "12.00",
        exp: expTs,
        sig,
      }),
    });

    expect(res.status).toBe(401);
    expect(mockedVerifyTransfer).not.toHaveBeenCalled();
  });

  it("does not let a newline in a value forge an extra field (legacy format)", async () => {
    const expTs = exp();
    const injected = {
      uid: "42",
      idtype: "tg",
      plan: "starter\nproduct=vibe",
      amountUsd: "12.00",
      exp: expTs,
    };
    // Signed with the OLD algorithm — the exact vector the legacy path must
    // refuse. The legacy branch rejects any value containing "\n" or "=".
    const sig = signIntentLegacy(injected);

    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xinject2",
        chainId: "base",
        token: "usdc",
        idType: "tg",
        uid: "42",
        plan: "starter",
        product: "vibe",
        amountUsd: "12.00",
        exp: expTs,
        sig,
      }),
    });

    // NOTE: on the legacy path the split replay is byte-identical to a genuine
    // `{plan:starter, product:vibe}` intent, so no value-level guard can tell
    // them apart. It is refused because a legacy signature may never carry
    // `product` at all — legacy signers predate multi-product.
    expect(res.status).toBe(401);
    expect(mockedVerifyTransfer).not.toHaveBeenCalled();
  });

  it("rejects the injected intent even when submitted verbatim on the legacy path", async () => {
    // Same signature, replayed with the newline value intact. The legacy path
    // must still refuse it (values containing "\n" are structurally ambiguous),
    // and the new path does not match because the signature is legacy-format.
    const expTs = exp();
    const injected = {
      uid: "42",
      idtype: "tg",
      plan: "starter\nproduct=vibe",
      amountUsd: "12.00",
      exp: expTs,
    };
    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xinject3",
        chainId: "base",
        token: "usdc",
        idType: "tg",
        uid: "42",
        plan: "starter\nproduct=vibe",
        amountUsd: "12.00",
        exp: expTs,
        sig: signIntentLegacy(injected),
      }),
    });
    expect(res.status).toBe(401);
  });

  it("does not let an '=' in a value shift a field boundary", async () => {
    const expTs = exp();
    // "uid=99" appended into plan. Under a naive parser the value could be read
    // as terminating early; length-prefixing makes the extent explicit.
    const injected = {
      uid: "42",
      idtype: "tg",
      plan: "starter=x",
      amountUsd: "12.00",
      exp: expTs,
    };
    const sig = signIntent(injected);

    // Replay claiming a different, shorter plan.
    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xinject4",
        chainId: "base",
        token: "usdc",
        idType: "tg",
        uid: "42",
        plan: "starter",
        amountUsd: "12.00",
        exp: expTs,
        sig,
      }),
    });
    expect(res.status).toBe(401);

    // And the legacy path must refuse an "=" bearing value outright.
    const res2 = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xinject5",
        chainId: "base",
        token: "usdc",
        idType: "tg",
        uid: "42",
        plan: "starter=x",
        amountUsd: "12.00",
        exp: expTs,
        sig: signIntentLegacy(injected),
      }),
    });
    expect(res2.status).toBe(401);
  });

  it("length-prefixed canonicalization separates the colliding pair", () => {
    // Direct demonstration, independent of the HTTP layer.
    const lp = (params: Record<string, string>) =>
      [...new URLSearchParams(params).entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k.length}:${k}=${v.length}:${v}`)
        .join("\n");
    const old = (params: Record<string, string>) =>
      [...new URLSearchParams(params).entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");

    const a = { plan: "starter\nproduct=vibe" };
    const b = { plan: "starter", product: "vibe" };

    expect(old(a)).toBe(old(b)); // the vulnerability
    expect(lp(a)).not.toBe(lp(b)); // fixed
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (f) Backward compatibility with production's legacy signatures
// ═══════════════════════════════════════════════════════════════════════════

describe("legacy canonical signatures keep validating", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Fixture produced by the OLD algorithm and HARDCODED here, so this test
   * cannot pass merely because the current code agrees with itself.
   *
   * canonical: "amountUsd=10.00\nexp=2000000000\nidtype=tg\nplan=starter\nuid=42"
   * hmac-sha256(key="test-callback-secret")
   */
  const LEGACY_EXP = "2000000000";
  const LEGACY_SIG = "fd865542bc1c06e25d763b67586b63ffe3b431fafa7793fd09319b9163241a00";

  it("accepts an intent signed with the pre-length-prefix algorithm", async () => {
    // Freeze the clock before the fixture's exp so the fixed signature stays valid.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_900_000_000 * 1000));

    mockedVerifyTransfer.mockResolvedValueOnce({
      from: "0xSender",
      to: "0xTestBaseWallet",
      amountRaw: "10000000",
      amountUsd: 10,
      token: "usdc",
      blockNumber: 1,
      txHash: "0xlegacyok",
    } as any);

    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xlegacyok",
        chainId: "base",
        token: "usdc",
        idType: "tg",
        uid: "42",
        plan: "starter",
        amountUsd: "10.00",
        exp: LEGACY_EXP,
        sig: LEGACY_SIG,
      }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).payment.plan_id).toBe("starter");
  });

  it("refuses a legacy signature for an email identity", async () => {
    // Legacy signers always emitted idtype=tg. Honouring a legacy signature for
    // an `email` identity would let a tg-signed intent be credited to the same
    // uid in the email namespace.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_900_000_000 * 1000));

    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xlegacyemail",
        chainId: "base",
        token: "usdc",
        idType: "email",
        uid: "42",
        plan: "starter",
        amountUsd: "10.00",
        exp: LEGACY_EXP,
        sig: LEGACY_SIG,
      }),
    });

    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (g) idType is signed, so the signed-intent path works for email (vibe)
// ═══════════════════════════════════════════════════════════════════════════

describe("signed-intent path supports email identities", () => {
  const exp = () => String(Math.floor(Date.now() / 1000) + 1800);

  it("round-trips an idType: 'email' signed intent", async () => {
    const expTs = exp();
    const signed = {
      uid: "buyer@example.com",
      idtype: "email",
      plan: "starter",
      amountUsd: "12.00",
      product: "vibe",
      exp: expTs,
    };

    mockedVerifyTransfer.mockResolvedValueOnce({
      from: "0xSender",
      to: "0xVibeBaseWallet",
      amountRaw: "12000000",
      amountUsd: 12,
      token: "usdc",
      blockNumber: 1,
      txHash: "0xemailok",
    } as any);

    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xemailok",
        chainId: "base",
        token: "usdc",
        idType: "email",
        uid: "buyer@example.com",
        plan: "starter",
        amountUsd: "12.00",
        product: "vibe",
        exp: expTs,
        sig: signIntent(signed),
      }),
    });

    expect(res.status).toBe(200);
    const [, , scopedConfig] = mockedVerifyTransfer.mock.calls[0] as any[];
    expect(scopedConfig.wallets.base).toBe("0xVibeBaseWallet");
  });

  it("rejects an email intent whose idtype was signed as tg", async () => {
    const expTs = exp();
    // Signed as tg...
    const signed = {
      uid: "buyer@example.com",
      idtype: "tg",
      plan: "starter",
      amountUsd: "12.00",
      product: "vibe",
      exp: expTs,
    };
    // ...submitted as email.
    const res = await app.request("/api/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0xemailswap",
        chainId: "base",
        token: "usdc",
        idType: "email",
        uid: "buyer@example.com",
        plan: "starter",
        amountUsd: "12.00",
        product: "vibe",
        exp: expTs,
        sig: signIntent(signed),
      }),
    });
    expect(res.status).toBe(401);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// (h) GET lazy re-verify re-validates the stored product
// ═══════════════════════════════════════════════════════════════════════════

describe("GET lazy re-verify validates meta.product", () => {
  it("errors on a removed/unknown product instead of falling back to openclaw", async () => {
    // Simulates a payment created while `ghost` was a configured product, then
    // polled after `ghost` was removed from PRODUCTS. Previously
    // `productConfig` coerced the unknown id to openclaw, so the pending
    // payment silently re-verified against OPENCLAW's wallet and price table.
    const payment = await insertPayment(mockDb, {
      idType: "tg",
      uid: "42",
      txHash: "0xghostproduct",
      chainId: "base",
      token: "usdc",
      amountRaw: "0",
      amountUsd: 0,
      planId: "starter",
      metadata: { product: "ghost", checkoutIntentVerified: true },
    } as any);

    expect(payment.status).toBe("pending");

    const res = await app.request(`/api/payment/${payment.id}`);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Unknown product: ghost/);
    // Crucially: no on-chain check was attempted against openclaw's wallet.
    expect(mockedVerifyTransfer).not.toHaveBeenCalled();
  });

  it("still lazily re-verifies a known product against ITS wallet", async () => {
    const payment = await insertPayment(mockDb, {
      idType: "tg",
      uid: "42",
      txHash: "0xvibepending",
      chainId: "base",
      token: "usdc",
      amountRaw: "0",
      amountUsd: 0,
      planId: "starter",
      metadata: { product: "vibe", checkoutIntentVerified: true },
    } as any);

    mockedVerifyTransfer.mockResolvedValueOnce({
      from: "0xSender",
      to: "0xVibeBaseWallet",
      amountRaw: "12000000",
      amountUsd: 12,
      token: "usdc",
      blockNumber: 1,
      txHash: "0xvibepending",
    } as any);

    const res = await app.request(`/api/payment/${payment.id}`);
    expect(res.status).toBe(200);

    const [, , scopedConfig] = mockedVerifyTransfer.mock.calls[0] as any[];
    expect(scopedConfig.wallets.base).toBe("0xVibeBaseWallet");
    expect(scopedConfig.prices.starter).toBe(12);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (i) txHash is normalized, so one tx cannot become two rows / two callbacks
// ═══════════════════════════════════════════════════════════════════════════

describe("txHash normalization", () => {
  it("treats differently-cased/padded hashes of one tx as a duplicate", async () => {
    const post = (txHash: string) =>
      app.request("/api/payment", {
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
        }),
      });

    mockedVerifyTransfer.mockResolvedValue({
      from: "0xSender",
      to: "0xTestBaseWallet",
      amountRaw: "10000000",
      amountUsd: 10,
      token: "usdc",
      blockNumber: 1,
      txHash: "0xabcdef",
    } as any);

    const first = await post("0xABCDEF");
    expect(first.status).toBe(200);

    // Same tx, lowercased and whitespace-padded — must be rejected as a
    // duplicate rather than creating a second row and a second callback.
    const second = await post("  0xabcdef  ");
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/already submitted/i);
  });
});
