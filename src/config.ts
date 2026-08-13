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

export interface PriceTable {
  starter: number;
  pro: number;
  max: number;
}

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
  };
  const baseTopupPrices: Record<string, number> = {
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
  for (const id of productIds) {
    const P = id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const num = (key: string, fallback: number) => Number(env(`${key}_${P}`)) || fallback;
    products[id] = {
      id,
      name: env(`PRODUCT_NAME_${P}`, id === DEFAULT_PRODUCT ? "OpenClaw Crypto Payments" : id),
      iconUrl: env(`PRODUCT_ICON_${P}`, "https://openclaw.ai/favicon.ico"),
      prices: {
        starter: num("PRICE_STARTER", basePrices.starter),
        pro: num("PRICE_PRO", basePrices.pro),
        max: num("PRICE_MAX", basePrices.max),
      },
      topupPrices: {
        small: num("TOPUP_PRICE_SMALL", baseTopupPrices.small),
        medium: num("TOPUP_PRICE_MEDIUM", baseTopupPrices.medium),
        large: num("TOPUP_PRICE_LARGE", baseTopupPrices.large),
      },
      wallets: {
        base: env(`WALLET_BASE_${P}`, baseWallets.base),
        eth: env(`WALLET_ETH_${P}`, baseWallets.eth),
        arbitrum: env(`WALLET_ARBITRUM_${P}`, baseWallets.arbitrum),
        ton: env(`WALLET_TON_${P}`, baseWallets.ton),
        sol: env(`WALLET_SOL_${P}`, baseWallets.sol),
        base_sepolia: env(`WALLET_BASE_SEPOLIA_${P}`, env(`WALLET_BASE_${P}`, baseWallets.base_sepolia)),
        eth_sepolia: env(`WALLET_ETH_SEPOLIA_${P}`, env(`WALLET_ETH_${P}`, baseWallets.eth_sepolia)),
      },
      callbackAllowlist: (() => {
        const raw = env(`CALLBACK_URL_ALLOWLIST_${P}`);
        return raw ? splitList(raw) : baseAllowlist;
      })(),
    };
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
 * Resolve a product's config. An absent/unknown product resolves to
 * `openclaw` — the pre-multi-product behaviour, which every legacy intent
 * depends on.
 */
export function productConfig(config: Config, product?: string | null): ProductConfig {
  const id = (product ?? "").trim() || DEFAULT_PRODUCT;
  return config.products[id] ?? config.products[DEFAULT_PRODUCT];
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
