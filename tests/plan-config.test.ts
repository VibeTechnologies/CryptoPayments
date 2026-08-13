import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, productConfig, InvalidPriceTableError, validatePriceTable } from "../src/config.js";
import { resolveplan } from "../src/verify.js";

/**
 * Per-product plan sets.
 *
 * The bug this file guards: `PriceTable` used to be a struct with FIXED
 * `starter`/`pro`/`max` fields, so every product was forced to have a `starter`
 * plan at openclaw's price. A $10 payment on a product that only sells
 * `pro`/`max` resolved to `plan:"starter"`, the consumer rejected it as
 * `unknown_plan` with a 400, and nothing redelivers a dropped callback — money
 * in, nothing out, permanently.
 */

const BASE_ENV: Record<string, string> = {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-key",
  API_KEY: "test-api-key",
  CALLBACK_SECRET: "test-callback-secret",
  CHECKOUT_SECRET: "test-callback-secret",
  WALLET_BASE: "0xGlobalBase",
  WALLET_ETH: "0xGlobalEth",
};

let saved: Record<string, string | undefined>;

/** Replace the whole PRODUCTS / PLANS / PRICE env surface for one test. */
function withEnv(overrides: Record<string, string>) {
  for (const key of Object.keys(process.env)) {
    if (/^(PRODUCTS|PLANS_|TOPUPS_|PRICE_|TOPUP_PRICE_|WALLET_|PRODUCT_NAME_|PRODUCT_ICON_|CALLBACK_URL_ALLOWLIST)/.test(key)) {
      delete process.env[key];
    }
  }
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...overrides })) process.env[k] = v;
}

beforeEach(() => {
  saved = { ...process.env } as Record<string, string | undefined>;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
});

describe("open per-product plan sets", () => {
  it("never resolves `starter` for a product that only declares pro/max — at ANY amount", () => {
    withEnv({
      PRODUCTS: "openclaw,vibe",
      PLANS_VIBE: "pro,max",
      PRICE_PRO_VIBE: "20",
      PRICE_MAX_VIBE: "99",
    });
    const config = loadConfig();
    const vibe = productConfig(config, "vibe");

    // The product's table contains EXACTLY its declared plans.
    expect(Object.keys(vibe.prices).sort()).toEqual(["max", "pro"]);
    expect(vibe.prices).toEqual({ pro: 20, max: 99 });
    expect(vibe.prices.starter).toBeUndefined();

    // The specific money-losing case: openclaw's `starter` price ($10) paid
    // against vibe. Must be unresolvable, not silently "starter".
    expect(resolveplan(10, config, "vibe")).toBeNull();

    // And no amount at all can produce "starter" for vibe.
    for (let amount = 0.5; amount <= 500; amount += 0.5) {
      const plan = resolveplan(amount, config, "vibe");
      expect(plan === null || plan === "pro" || plan === "max").toBe(true);
    }

    // Its own plans still resolve.
    expect(resolveplan(20, config, "vibe")).toBe("pro");
    expect(resolveplan(99, config, "vibe")).toBe("max");

    // openclaw is unaffected and keeps `starter`.
    expect(resolveplan(10, config, "openclaw")).toBe("starter");
  });

  it("does not let a product inherit a plan it did not declare", () => {
    withEnv({
      PRODUCTS: "openclaw,vibe",
      PRICE_STARTER: "10",
      PRICE_PRO: "25",
      PRICE_MAX: "100",
      PLANS_VIBE: "pro,max",
      PRICE_PRO_VIBE: "30",
      PRICE_MAX_VIBE: "120",
    });
    const config = loadConfig();
    expect(productConfig(config, "vibe").prices).toEqual({ pro: 30, max: 120 });
  });

  it("applies the same open-set treatment to top-up packs", () => {
    withEnv({
      PRODUCTS: "openclaw,vibe",
      TOPUPS_VIBE: "small,large",
      TOPUP_PRICE_SMALL_VIBE: "7",
      TOPUP_PRICE_LARGE_VIBE: "70",
    });
    const vibe = productConfig(loadConfig(), "vibe");
    expect(vibe.topupPrices).toEqual({ small: 7, large: 70 });
    expect(vibe.topupPrices.medium).toBeUndefined();
  });

  it("supports plan names openclaw never had", () => {
    withEnv({
      PRODUCTS: "openclaw,vibe",
      PLANS_VIBE: "team,enterprise",
      PRICE_TEAM_VIBE: "49",
      PRICE_ENTERPRISE_VIBE: "499",
    });
    const config = loadConfig();
    expect(productConfig(config, "vibe").prices).toEqual({ team: 49, enterprise: 499 });
    expect(resolveplan(49, config, "vibe")).toBe("team");
    expect(resolveplan(499, config, "vibe")).toBe("enterprise");
  });

  it("fails startup when a declared plan has no price", () => {
    withEnv({ PRODUCTS: "openclaw,vibe", PLANS_VIBE: "pro,max", PRICE_PRO_VIBE: "30" });
    // PRICE_MAX falls back from the flat default (100) only if the flat var is
    // set; it is not here, so `max` is unpriced and startup must fail.
    expect(() => loadConfig()).toThrow(InvalidPriceTableError);
  });
});

describe("backward compatibility with the flat PRICE_* env vars", () => {
  it("resolves openclaw exactly as before when only the flat vars are set", () => {
    withEnv({});
    const config = loadConfig();

    // Hardcoded expectations — NOT derived by calling the new code twice.
    expect(config.prices).toEqual({ starter: 10, pro: 25, max: 100 });
    expect(productConfig(config, "openclaw").prices).toEqual({ starter: 10, pro: 25, max: 100 });
    expect(productConfig(config, undefined).prices).toEqual({ starter: 10, pro: 25, max: 100 });
    expect(productConfig(config, "openclaw").topupPrices).toEqual({ small: 5, medium: 10, large: 25 });

    // The exact resolution table asserted before this change (tests/payments.test.ts).
    expect(resolveplan(10, config, "openclaw")).toBe("starter");
    expect(resolveplan(25, config, "openclaw")).toBe("pro");
    expect(resolveplan(100, config, "openclaw")).toBe("max");
    expect(resolveplan(9.95, config, "openclaw")).toBe("starter");
    expect(resolveplan(10.05, config, "openclaw")).toBe("starter");
    expect(resolveplan(24.8, config, "openclaw")).toBe("pro");
    expect(resolveplan(100.5, config, "openclaw")).toBe("max");
    expect(resolveplan(50, config, "openclaw")).toBeNull();
    expect(resolveplan(0, config, "openclaw")).toBeNull();
  });

  it("honours explicit flat overrides", () => {
    withEnv({ PRICE_STARTER: "9", PRICE_PRO: "29", PRICE_MAX: "99" });
    const config = loadConfig();
    expect(productConfig(config, "openclaw").prices).toEqual({ starter: 9, pro: 29, max: 99 });
    expect(resolveplan(99, config, "openclaw")).toBe("max");
  });

  it("keeps the flat table for an extra product that declares no plan set", () => {
    withEnv({ PRODUCTS: "openclaw,vibe", PRICE_STARTER_VIBE: "12", PRICE_PRO_VIBE: "30", PRICE_MAX_VIBE: "120" });
    expect(productConfig(loadConfig(), "vibe").prices).toEqual({ starter: 12, pro: 30, max: 120 });
  });
});

describe("price-table ambiguity validation", () => {
  it("rejects a product whose plan bands overlap", () => {
    withEnv({
      PRODUCTS: "openclaw,vibe",
      PLANS_VIBE: "pro,max",
      PRICE_PRO_VIBE: "99",
      PRICE_MAX_VIBE: "99.5", // $0.50 apart — no matcher can disambiguate
    });
    expect(() => loadConfig()).toThrow(InvalidPriceTableError);
    expect(() => loadConfig()).toThrow(/overlapping match bands/);
  });

  it("rejects two plans priced identically", () => {
    withEnv({
      PRODUCTS: "openclaw,vibe",
      PLANS_VIBE: "pro,max",
      PRICE_PRO_VIBE: "50",
      PRICE_MAX_VIBE: "50",
    });
    expect(() => loadConfig()).toThrow(InvalidPriceTableError);
  });

  it("rejects a flat table made ambiguous by an override", () => {
    withEnv({ PRICE_STARTER: "10", PRICE_PRO: "10.5", PRICE_MAX: "100" });
    expect(() => loadConfig()).toThrow(InvalidPriceTableError);
  });

  it("accepts a table whose plans are comfortably separated", () => {
    withEnv({
      PRODUCTS: "openclaw,vibe",
      PLANS_VIBE: "pro,max",
      PRICE_PRO_VIBE: "20",
      PRICE_MAX_VIBE: "99",
    });
    expect(() => loadConfig()).not.toThrow();
  });

  describe("validatePriceTable directly", () => {
    it("flags an empty table", () => {
      expect(validatePriceTable("t", {})).toHaveLength(1);
    });

    it("flags a non-positive price", () => {
      expect(validatePriceTable("t", { pro: 0 }).join()).toMatch(/non-positive/);
      expect(validatePriceTable("t", { pro: -5 }).join()).toMatch(/non-positive/);
    });

    it("passes the historical openclaw table", () => {
      expect(validatePriceTable("t", { starter: 10, pro: 25, max: 100 })).toEqual([]);
    });

    it("flags a sub-$2 gap even when the relative bands would clear", () => {
      // 100 vs 101.5: relative span is 100*0.01 + 101.5*0.01 ≈ 2.015 -> caught.
      // 500 vs 501.5: relative span ≈ 10 -> also caught. The absolute floor
      // matters for SMALL prices: 5 vs 6.5 has a relative span of 0.115 but a
      // downstream ±$1 matcher would see both.
      expect(validatePriceTable("t", { a: 5, b: 6.5 }).join()).toMatch(/overlapping match bands/);
      expect(validatePriceTable("t", { a: 5, b: 8 })).toEqual([]);
    });
  });
});
