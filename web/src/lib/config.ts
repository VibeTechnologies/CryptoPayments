// API configuration and types

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  "https://wxxnkncwneyhmudfyayd.supabase.co/functions/v1/crypto-payments";

export type ChainId = "base" | "eth" | "sol" | "ton" | "base_sepolia";
export type TokenId = "usdc" | "usdt";

export interface AppConfig {
  wallets: Record<ChainId, string>;
  prices: Record<string, number>;
  tokens: Record<ChainId, Record<TokenId, string>>;
  chains: ChainId[];
}

export interface PaymentRequest {
  txHash: string;
  chainId: ChainId;
  token: TokenId;
  idType: "tg" | "email";
  uid: string;
  plan?: string;
  callbackUrl?: string;
  initData?: string;
}

export interface PaymentResult {
  payment: {
    id: string;
    status: "pending" | "verified" | "failed";
    amount_usd: number;
    token: string;
    chain_id: string;
    plan_id?: string;
    tx_hash: string;
  };
  error?: string;
}

export const CHAINS: { id: ChainId; name: string; icon: string; testnet?: boolean }[] = [
  { id: "base", name: "Base", icon: "🔵" },
  { id: "eth", name: "Ethereum", icon: "⟠" },
  { id: "sol", name: "Solana", icon: "◎" },
  { id: "ton", name: "TON", icon: "💎" },
  { id: "base_sepolia", name: "Base Sepolia", icon: "🧪", testnet: true },
];

export const TOKENS: { id: TokenId; name: string }[] = [
  { id: "usdc", name: "USDC" },
  { id: "usdt", name: "USDT" },
];

// EVM chain IDs for wallet_switchEthereumChain
export const EVM_CHAIN_IDS: Record<string, string> = {
  base: "0x2105",
  eth: "0x1",
  base_sepolia: "0x14a34",
};

// Full chain params for wallet_addEthereumChain (testnets / non-default chains)
export const EVM_CHAIN_PARAMS: Record<
  string,
  {
    chainId: string;
    chainName: string;
    rpcUrls: string[];
    nativeCurrency: { name: string; symbol: string; decimals: number };
    blockExplorerUrls: string[];
  }
> = {
  base_sepolia: {
    chainId: "0x14a34",
    chainName: "Base Sepolia",
    rpcUrls: ["https://sepolia.base.org"],
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    blockExplorerUrls: ["https://sepolia.basescan.org"],
  },
};

export const EVM_CHAINS: ChainId[] = ["base", "eth", "base_sepolia"];

// ERC-20 transfer ABI
export const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];
