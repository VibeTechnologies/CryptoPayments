/**
 * Product (tenant) identifier. The service is multi-product: OpenClawBot and
 * vibebrowser both settle through it, with independent price tables, receiving
 * wallets and callback allowlists.
 *
 * `openclaw` is the DEFAULT and must stay the default forever: every intent
 * signed before multi-product support existed carries no `product` field, and
 * those intents are live in production.
 */
export const DEFAULT_PRODUCT = "openclaw";

/**
 * A product's plan set: plan name -> USD price.
 *
 * DELIBERATELY OPEN (a map, not a struct with fixed `starter`/`pro`/`max`
 * fields). A fixed struct forced every product to have a `starter` plan, so a
 * product that only sells `pro`/`max` still inherited openclaw's $10 `starter`
 * price and `resolveplan` happily returned `"starter"` for a $10 payment. The
 * consumer then rejected `plan:"starter"` as `unknown_plan` with a 400, and
 * because a dropped callback is only logged and never redelivered, the money
 * was taken and nothing was ever delivered.
 *
 * A product declares its own set with `PLANS_<PRODUCT>` (see `loadConfig`) and
 * then contains EXACTLY those plans — it never inherits a plan it did not
 * declare.
 */
export type PriceTable = Record<string, number>;

export interface WalletTable {
  base: string;
  eth: string;
  arbitrum: string;
  ton: string;
  sol: string;
  base_sepolia: string;
  eth_sepolia: string;
}

export interface ProductConfig {
  /** Product id, e.g. "openclaw" | "vibe" */
  id: string;
  /** Display name used for branding (TonConnect manifest, pay page). */
  name: string;
  /** Favicon / icon URL used for branding. */
  iconUrl: string;
  prices: PriceTable;
  topupPrices: Record<string, number>;
  /** Receiving wallets for this product (falls back to the global WALLET_* vars). */
  wallets: WalletTable;
  /** Hostnames sendCallback may POST to for this product. */
  callbackAllowlist: string[];
}

export interface Config {
  port: number;
  /** Supabase project URL */
  supabaseUrl: string;
  /** Supabase service role key (bypasses RLS) */
  supabaseKey: string;
  /** Default-product (openclaw) wallets. Kept flat for backward compatibility. */
  wallets: WalletTable;
  rpc: {
    base: string;
    eth: string;
    arbitrum: string;
    sol: string;
    ton: string;
    base_sepolia: string;
    eth_sepolia: string;
  };
  /** Default-product (openclaw) prices. Kept flat for backward compatibility. */
  prices: PriceTable;
  /** Per-product configuration, keyed by product id. Always contains `openclaw`. */
  products: Record<string, ProductConfig>;
  /** Telegram bot token — required for initData verification in Mini App mode */
  telegramBotToken: string;
  /** Shared API key for bot-to-payment-service calls */
  apiKey: string;
  /** HMAC secret for webhook callbacks to OpenClawBot */
  callbackSecret: string;
  /** Shared secret for signed checkout intents. Defaults to callbackSecret. */
  checkoutSecret: string;
  /** Base URL for the payment page (for generating links) */
  baseUrl: string;
  /** Allowlisted hostnames for outbound webhook callbacks (SSRF guard) */
  callbackAllowlist: string[];
}

/** Read an env var with an optional fallback (Deno + Node compatible). */
const env = (key: string, fallback = ""): string => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.Deno?.env?.get) return g.Deno.env.get(key) ?? fallback;
  return g.process?.env?.[key] ?? fallback;
};

const splitList = (raw: string): string[] =>
  raw.split(",").map((s) => s.trim()).filter(Boolean);

/** Env-var-safe upper-cased form of an id: `base_sepolia` -> `BASE_SEPOLIA`. */
const envKey = (name: string): string => name.toUpperCase().replace(/[^A-Z0-9]/g, "_");

/**
 * Relative tolerance `resolveplan` uses when matching an on-chain USD amount to
 * a plan price (1%).
 */
export const PLAN_MATCH_TOLERANCE = 0.01;

/**
 * Absolute slack (USD) assumed for DOWNSTREAM amount-based matching.
 *
 * This service resolves a plan with a RELATIVE band (`PLAN_MATCH_TOLERANCE`),
 * but consumers of the callback may re-derive the plan with a small ABSOLUTE
 * band instead. This repo cannot know a consumer's prices, and must not encode
 * them; what it CAN do is refuse to accept a price table where two plans sit so
 * close together that any reasonable amount-based matcher would be ambiguous.
 */
export const PLAN_ABSOLUTE_SLACK_USD = 1;

/**
 * Validate one product's price map: every price must be a positive finite
 * number, and no two plans may have overlapping match bands.
 *
 * Overlapping bands make amount-based resolution AMBIGUOUS: the plan a payment
 * resolves to then depends on iteration order rather than on the amount, and a
 * downstream consumer matching with its own (possibly absolute) tolerance can
 * disagree with us about the same payment. That disagreement is unrecoverable —
 * the consumer 400s and the callback is never retried — so it is rejected at
 * startup instead of being discovered in production.
 *
 * @returns human-readable problems; empty means valid.
 */
export function validatePriceTable(label: string, table: Record<string, number>): string[] {
  const problems: string[] = [];
  const entries = Object.entries(table);
  if (entries.length === 0) {
    problems.push(`${label}: no plans configured`);
    return problems;
  }
  for (const [plan, price] of entries) {
    if (!Number.isFinite(price) || price <= 0) {
      problems.push(`${label}: plan "${plan}" has a non-positive/invalid price (${price})`);
    }
  }
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [planA, a] = entries[i];
      const [planB, b] = entries[j];
      if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue;
      const gap = Math.abs(a - b);
      // Bands overlap under EITHER matcher: our relative one, or a downstream
      // absolute one. `2 * SLACK` because each price carries ±SLACK.
      const relativeSpan = a * PLAN_MATCH_TOLERANCE + b * PLAN_MATCH_TOLERANCE;
      const absoluteSpan = 2 * PLAN_ABSOLUTE_SLACK_USD;
      const required = Math.max(relativeSpan, absoluteSpan);
      if (gap <= required) {
        problems.push(
          `${label}: plans "${planA}" ($${a}) and "${planB}" ($${b}) have overlapping match bands ` +
            `(gap $${gap.toFixed(2)} <= $${required.toFixed(2)}) — an on-chain amount cannot be resolved to one plan unambiguously`,
        );
      }
    }
  }
  return problems;
}

/** Thrown at startup when a configured price table is internally inconsistent. */
export class InvalidPriceTableError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid price configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "InvalidPriceTableError";
  }
}

export function loadConfig(): Config {
  // Security startup warnings — logged once at boot so ops notices misconfiguration.
  if (!env("API_KEY")) {
    console.warn("[SECURITY] API_KEY is empty — all admin endpoints will reject");
  }
  if (!env("CHECKOUT_SECRET")) {
    console.warn("[SECURITY] CHECKOUT_SECRET not set; falling back to CALLBACK_SECRET — set a distinct value");
  }

  const baseWallets: WalletTable = {
    base: env("WALLET_BASE"),
    eth: env("WALLET_ETH"),
    arbitrum: env("WALLET_ARBITRUM"),
    ton: env("WALLET_TON"),
    sol: env("WALLET_SOL"),
    base_sepolia: env("WALLET_BASE_SEPOLIA", env("WALLET_BASE")),
    eth_sepolia: env("WALLET_ETH_SEPOLIA", env("WALLET_ETH")),
  };
  const basePrices: PriceTable = {
    starter: Number(env("PRICE_STARTER")) || 10,
    pro: Number(env("PRICE_PRO")) || 25,
    max: Number(env("PRICE_MAX")) || 100,
  };  const baseTopupPrices: Record<string, number> = {
    small: Number(env("TOPUP_PRICE_SMALL")) || 5,
    medium: Number(env("TOPUP_PRICE_MEDIUM")) || 10,
    large: Number(env("TOPUP_PRICE_LARGE")) || 25,
  };
  const baseAllowlist = splitList(
    env(
      "CALLBACK_URL_ALLOWLIST",
      "admin.openclaw.agentlabs.cc,admin.openclaw.vibebrowser.app,pay.agentlabs.cc",
    ),
  );

  // Every product listed in PRODUCTS gets a config. Each field falls back to
  // the corresponding flat env var, so `openclaw` is byte-for-byte what it was
  // before multi-product support and a product with no overrides shares the
  // same wallets/prices/allowlist (a shared wallet stays possible).
  const productIds = splitList(env("PRODUCTS", DEFAULT_PRODUCT));
  if (!productIds.includes(DEFAULT_PRODUCT)) productIds.unshift(DEFAULT_PRODUCT);

  const products: Record<string, ProductConfig> = {};
  const priceProblems: string[] = [];
  const inheritedWallets: string[] = [];
  for (const id of productIds) {
    const P = envKey(id);
    const num = (key: string, fallback: number) => Number(env(`${key}_${P}`)) || fallback;

    // ── Plan set ────────────────────────────────────────────────────────────
    //
    // `PLANS_<PRODUCT>` declares the product's plan names, e.g.
    // `PLANS_VIBE=pro,max`. Each declared plan is priced by
    // `PRICE_<PLAN>_<PRODUCT>` (e.g. `PRICE_PRO_VIBE`), falling back to the
    // flat `PRICE_<PLAN>` only when the flat var exists.
    //
    // A product that declares a plan set contains EXACTLY that set — it does
    // NOT inherit openclaw's other plans. That is the whole point: vibe sells
    // `pro`/`max`, so a $10 payment on vibe must resolve to `null`, never to
    // openclaw's `starter`.
    //
    // With no `PLANS_<PRODUCT>` the product inherits the flat
    // `PRICE_STARTER`/`PRICE_PRO`/`PRICE_MAX` table, optionally overridden per
    // product — byte-for-byte the pre-existing behaviour.
    const declaredPlans = splitList(env(`PLANS_${P}`));
    let prices: PriceTable;
    if (declaredPlans.length > 0) {
      prices = {};
      for (const plan of declaredPlans) {
        const raw = env(`PRICE_${envKey(plan)}_${P}`) || env(`PRICE_${envKey(plan)}`);
        const price = Number(raw);
        if (!raw || !Number.isFinite(price) || price <= 0) {
          priceProblems.push(
            `product "${id}": plan "${plan}" is declared in PLANS_${P} but has no valid price ` +
              `(set PRICE_${envKey(plan)}_${P})`,
          );
          continue;
        }
        prices[plan] = price;
      }
    } else {
      prices = {
        starter: num("PRICE_STARTER", basePrices.starter),
        pro: num("PRICE_PRO", basePrices.pro),
        max: num("PRICE_MAX", basePrices.max),
      };
    }
    priceProblems.push(...validatePriceTable(`product "${id}" prices`, prices));

    // ── Top-up packs ────────────────────────────────────────────────────────
    // Same open-set treatment: `TOPUPS_<PRODUCT>=small,large` +
    // `TOPUP_PRICE_<PACK>_<PRODUCT>`. Top-up packs are selected BY NAME (the
    // signed `topup` field), not by amount, so an ambiguous-band check does not
    // apply — but an undeclared pack must still not be inherited, otherwise a
    // product would advertise a pack its consumer cannot credit.
    const declaredTopups = splitList(env(`TOPUPS_${P}`));
    let topupPrices: Record<string, number>;
    if (declaredTopups.length > 0) {
      topupPrices = {};
      for (const pack of declaredTopups) {
        const raw = env(`TOPUP_PRICE_${envKey(pack)}_${P}`) || env(`TOPUP_PRICE_${envKey(pack)}`);
        const price = Number(raw);
        if (!raw || !Number.isFinite(price) || price <= 0) {
          priceProblems.push(
            `product "${id}": top-up pack "${pack}" is declared in TOPUPS_${P} but has no valid price ` +
              `(set TOPUP_PRICE_${envKey(pack)}_${P})`,
          );
          continue;
        }
        topupPrices[pack] = price;
      }
    } else {
      topupPrices = {
        small: num("TOPUP_PRICE_SMALL", baseTopupPrices.small),
        medium: num("TOPUP_PRICE_MEDIUM", baseTopupPrices.medium),
        large: num("TOPUP_PRICE_LARGE", baseTopupPrices.large),
      };
    }

    // ── Wallets ─────────────────────────────────────────────────────────────
    // A product with no `WALLET_<CHAIN>_<PRODUCT>` shares the global receiving
    // wallet. That is intentional and stays supported — but it used to be
    // SILENT, so a vibe deploy that forgot `WALLET_BASE_VIBE` quietly collected
    // vibe's revenue into openclaw's wallet. Each inheritance is now named in a
    // startup warning.
    const walletFor = (chain: keyof WalletTable, fallback: string): string => {
      const own = env(`WALLET_${envKey(chain)}_${P}`);
      if (own) return own;
      if (id !== DEFAULT_PRODUCT && fallback) inheritedWallets.push(`${id}/${chain}`);
      return fallback;
    };

    products[id] = {
      id,
      name: env(`PRODUCT_NAME_${P}`, id === DEFAULT_PRODUCT ? "OpenClaw Crypto Payments" : id),
      iconUrl: env(`PRODUCT_ICON_${P}`, "https://openclaw.ai/favicon.ico"),
      prices,
      topupPrices,
      wallets: {
        base: walletFor("base", baseWallets.base),
        eth: walletFor("eth", baseWallets.eth),
        arbitrum: walletFor("arbitrum", baseWallets.arbitrum),
        ton: walletFor("ton", baseWallets.ton),
        sol: walletFor("sol", baseWallets.sol),
        base_sepolia: env(`WALLET_BASE_SEPOLIA_${P}`, env(`WALLET_BASE_${P}`, baseWallets.base_sepolia)),
        eth_sepolia: env(`WALLET_ETH_SEPOLIA_${P}`, env(`WALLET_ETH_${P}`, baseWallets.eth_sepolia)),
      },
      callbackAllowlist: (() => {
        const raw = env(`CALLBACK_URL_ALLOWLIST_${P}`);
        return raw ? splitList(raw) : baseAllowlist;
      })(),
    };
  }

  // Fail LOUDLY rather than booting with a price table that silently
  // misresolves payments. A misresolved plan is unrecoverable downstream: the
  // consumer 400s on the unknown plan and the callback is never retried.
  if (priceProblems.length > 0) throw new InvalidPriceTableError(priceProblems);

  if (inheritedWallets.length > 0) {
    console.warn(
      `[CONFIG] Products inheriting the GLOBAL receiving wallet (no WALLET_<CHAIN>_<PRODUCT> set): ` +
        `${inheritedWallets.join(", ")} — these funds land in the default product's wallet. ` +
        `Set the per-product vars if this is not intended.`,
    );
  }

  return {
    port: Number(env("PORT")) || 3003,
    supabaseUrl: env("SUPABASE_URL"),
    supabaseKey: env("SUPABASE_SERVICE_ROLE_KEY"),
    wallets: baseWallets,
    rpc: {
      base: env("RPC_BASE", "https://mainnet.base.org"),
      eth: env("RPC_ETH", "https://cloudflare-eth.com"),
      arbitrum: env("RPC_ARBITRUM", "https://arb1.arbitrum.io/rpc"),
      sol: env("RPC_SOL", "https://api.mainnet-beta.solana.com"),
      ton: env("RPC_TON", "https://toncenter.com/api/v3"),
      base_sepolia: env("RPC_BASE_SEPOLIA", "https://sepolia.base.org"),
      eth_sepolia: env("RPC_ETH_SEPOLIA", "https://ethereum-sepolia-rpc.publicnode.com"),
    },
    prices: basePrices,
    products,
    telegramBotToken: env("TELEGRAM_BOT_TOKEN"),
    apiKey: env("API_KEY"),
    callbackSecret: env("CALLBACK_SECRET"),
    checkoutSecret: env("CHECKOUT_SECRET", env("CALLBACK_SECRET")),
    baseUrl: env("BASE_URL", "https://pay.openclaw.ai"),
    // Hosts sendCallback is allowed to POST a verified-payment webhook to.
    //
    // MUST cover BOTH domain suffixes while the vibebrowser.app -> agentlabs.cc
    // migration is in flight. OpenClawBot deploys with
    // DOMAIN_SUFFIX=openclaw.agentlabs.cc, so it builds
    // admin.openclaw.agentlabs.cc. That host was missing here, and the miss is
    // SILENT — sendCallback logs a warning and returns, leaving the payment
    // `verified` with no webhook, no retry and no record. The customer pays and
    // receives nothing (OpenClawBot#3600).
    //
    // Do not prune an entry here just because it looks unused: this list is the
    // only thing standing between a settled payment and a black hole, and
    // nothing in either service detects a drop.
    callbackAllowlist: baseAllowlist,
  };
}

/** Supported chain identifiers */
export type ChainId = "base" | "eth" | "arbitrum" | "ton" | "sol" | "base_sepolia" | "eth_sepolia";

/** Token contract/mint addresses per chain (all 6 decimals) */
export const TOKEN_ADDRESSES: Record<ChainId, { usdt: string; usdc: string; ausd?: string }> = {
  base: {
    usdt: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  eth: {
    usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  arbitrum: {
    usdt: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  ton: {
    usdt: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",
    usdc: "EQCxlMUk0_5_TABhCHdXqHEVjYpOCnFBkKpKGRpMpech0diD",
  },
  sol: {
    usdt: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  base_sepolia: {
    usdt: "0x", // No official USDT on Base Sepolia — placeholder
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Circle testnet USDC
  },
  eth_sepolia: {
    usdt: "0x", // No official USDT on Ethereum Sepolia — placeholder
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Circle testnet USDC on Eth Sepolia
    ausd: "0xfCCfda616e5107AC579712C5A461397f88e8e3f2", // AgentUSD — redeployed 2026-07-24 (owner key of prior 0x76B2AeC0... lost; deployer retains mint)
  },
};

export type TokenId = "usdt" | "usdc" | "ausd";

/**
 * Resolve a product's config.
 *
 * An ABSENT/empty product resolves to `openclaw` — the pre-multi-product
 * behaviour that every legacy intent depends on. An UNKNOWN product THROWS.
 *
 * Throwing (rather than silently coercing to the default) matters because
 * `product` selects the receiving wallet, the price table and the callback
 * allowlist. The old fallback meant that removing a product from `PRODUCTS`
 * while payments were pending caused those payments to be re-verified against
 * openclaw's wallet and prices on the GET lazy-re-verify path, which had no
 * validation gate of its own.
 *
 * Callers that legitimately want lenient behaviour for a cosmetic,
 * client-supplied id (branding endpoints) must use `productConfigOrDefault`.
 */
export function productConfig(config: Config, product?: string | null): ProductConfig {
  const id = (product ?? "").trim() || DEFAULT_PRODUCT;
  const resolved = config.products[id];
  if (!resolved) throw new UnknownProductError(id);
  return resolved;
}

/** Error thrown by `productConfig` for a product id that is not configured. */
export class UnknownProductError extends Error {
  constructor(public readonly productId: string) {
    super(`Unknown product: ${productId}`);
    this.name = "UnknownProductError";
  }
}

/**
 * Lenient variant for COSMETIC uses only (product name/icon on public branding
 * endpoints), where an unknown `?product=` query param must not 500. Never use
 * this where wallets, prices or the callback allowlist are consumed.
 */
export function productConfigOrDefault(config: Config, product?: string | null): ProductConfig {
  try {
    return productConfig(config, product);
  } catch {
    return config.products[DEFAULT_PRODUCT];
  }
}

/**
 * A Config whose `wallets` are the given product's receiving wallets.
 *
 * Used so `verifyTransfer` keeps its exact on-chain logic and simply checks a
 * different recipient. For a product with no wallet overrides this returns the
 * same addresses as before (shared wallet).
 */
export function configForProduct(config: Config, product?: string | null): Config {
  const p = productConfig(config, product);
  return { ...config, wallets: p.wallets, prices: p.prices, callbackAllowlist: p.callbackAllowlist };
}
