import "dotenv/config";

export interface Config {
  port: number;
  databaseUrl: string;
  wallets: {
    base: string;
    eth: string;
    ton: string;
    sol: string;
  };
  rpc: {
    base: string;
    eth: string;
    sol: string;
    ton: string;
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
  /** Base URL for the payment page (for generating links) */
  baseUrl: string;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT) || 3003,
    databaseUrl: process.env.DATABASE_URL ?? "./data/payments.db",
    wallets: {
      base: process.env.WALLET_BASE ?? "",
      eth: process.env.WALLET_ETH ?? "",
      ton: process.env.WALLET_TON ?? "",
      sol: process.env.WALLET_SOL ?? "",
    },
    rpc: {
      base: process.env.RPC_BASE ?? "https://mainnet.base.org",
      eth: process.env.RPC_ETH ?? "https://cloudflare-eth.com",
      sol: process.env.RPC_SOL ?? "https://api.mainnet-beta.solana.com",
      ton: process.env.RPC_TON ?? "https://toncenter.com/api/v2",
    },
    prices: {
      starter: Number(process.env.PRICE_STARTER) || 10,
      pro: Number(process.env.PRICE_PRO) || 25,
      max: Number(process.env.PRICE_MAX) || 100,
    },
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    apiKey: process.env.API_KEY ?? "",
    callbackSecret: process.env.CALLBACK_SECRET ?? "",
    baseUrl: process.env.BASE_URL ?? "https://pay.openclaw.ai",
  };
}

/** Supported chain identifiers */
export type ChainId = "base" | "eth" | "ton" | "sol";

/** Token contract/mint addresses per chain (all 6 decimals) */
export const TOKEN_ADDRESSES: Record<ChainId, { usdt: string; usdc: string }> = {
  base: {
    usdt: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  eth: {
    usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  ton: {
    usdt: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",
    usdc: "EQCxlMUk0_5_TABhCHdXqHEVjYpOCnFBkKpKGRpMpech0diD",
  },
  sol: {
    usdt: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
};

export type TokenId = "usdt" | "usdc";
