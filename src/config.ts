export interface Config {
  port: number;
  /** Supabase project URL */
  supabaseUrl: string;
  /** Supabase service role key (bypasses RLS) */
  supabaseKey: string;
  wallets: {
    base: string;
    eth: string;
    arbitrum: string;
    ton: string;
    sol: string;
    base_sepolia: string;
    eth_sepolia: string;
  };
  rpc: {
    base: string;
    eth: string;
    arbitrum: string;
    sol: string;
    ton: string;
    base_sepolia: string;
    eth_sepolia: string;
  };
  prices: {
    starter: number;
    pro: number;
    max: number;
  };
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
}

/** Read an env var with an optional fallback (Deno + Node compatible). */
const env = (key: string, fallback = ""): string => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.Deno?.env?.get) return g.Deno.env.get(key) ?? fallback;
  return g.process?.env?.[key] ?? fallback;
};

export function loadConfig(): Config {
  return {
    port: Number(env("PORT")) || 3003,
    supabaseUrl: env("SUPABASE_URL"),
    supabaseKey: env("SUPABASE_SERVICE_ROLE_KEY"),
    wallets: {
      base: env("WALLET_BASE"),
      eth: env("WALLET_ETH"),
      arbitrum: env("WALLET_ARBITRUM"),
      ton: env("WALLET_TON"),
      sol: env("WALLET_SOL"),
      base_sepolia: env("WALLET_BASE_SEPOLIA", env("WALLET_BASE")),
      eth_sepolia: env("WALLET_ETH_SEPOLIA", env("WALLET_ETH")),
    },
    rpc: {
      base: env("RPC_BASE", "https://mainnet.base.org"),
      eth: env("RPC_ETH", "https://cloudflare-eth.com"),
      arbitrum: env("RPC_ARBITRUM", "https://arb1.arbitrum.io/rpc"),
      sol: env("RPC_SOL", "https://api.mainnet-beta.solana.com"),
      ton: env("RPC_TON", "https://toncenter.com/api/v3"),
      base_sepolia: env("RPC_BASE_SEPOLIA", "https://sepolia.base.org"),
      eth_sepolia: env("RPC_ETH_SEPOLIA", "https://ethereum-sepolia-rpc.publicnode.com"),
    },
    prices: {
      starter: Number(env("PRICE_STARTER")) || 10,
      pro: Number(env("PRICE_PRO")) || 25,
      max: Number(env("PRICE_MAX")) || 100,
    },
    telegramBotToken: env("TELEGRAM_BOT_TOKEN"),
    apiKey: env("API_KEY"),
    callbackSecret: env("CALLBACK_SECRET"),
    checkoutSecret: env("CHECKOUT_SECRET", env("CALLBACK_SECRET")),
    baseUrl: env("BASE_URL", "https://pay.openclaw.ai"),
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
    ausd: "0x76B2AeC049e93FB53f210a4B0f02fe3Dee6514C3", // AgentUSD — deployed 2026-06-26
  },
};

export type TokenId = "usdt" | "usdc" | "ausd";
