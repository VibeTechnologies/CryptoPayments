import { createPublicClient, http, parseAbiItem, type Address, formatUnits } from "viem";
import { base, mainnet } from "viem/chains";
import type { ChainId, Config } from "./config.js";
import { TOKEN_ADDRESSES } from "./config.js";

/** ERC-20 Transfer event signature */
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

export interface VerifiedTransfer {
  from: string;
  to: string;
  /** Raw token amount (integer string, 6 decimals) */
  amountRaw: string;
  /** Human-readable USD amount */
  amountUsd: number;
  /** Which token was transferred */
  token: "usdt" | "usdc";
  blockNumber: number;
  txHash: string;
}

/**
 * Verify an ERC-20 stablecoin transfer on Base or Ethereum.
 * Checks that the tx contains a Transfer event to our wallet for USDT or USDC.
 */
export async function verifyEvmTransfer(
  txHash: string,
  chainId: "base" | "eth",
  config: Config,
): Promise<VerifiedTransfer | null> {
  const chain = chainId === "base" ? base : mainnet;
  const rpcUrl = chainId === "base" ? config.rpc.base : config.rpc.eth;
  const recipientWallet = (chainId === "base" ? config.wallets.base : config.wallets.eth).toLowerCase();

  if (!recipientWallet) {
    throw new Error(`No wallet configured for chain ${chainId}`);
  }

  const client = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  // Get transaction receipt
  const receipt = await client.getTransactionReceipt({
    hash: txHash as `0x${string}`,
  });

  if (!receipt || receipt.status === "reverted") {
    return null;
  }

  // Look for Transfer events to our wallet from known stablecoins
  const tokens = TOKEN_ADDRESSES[chainId];
  const usdtAddress = tokens.usdt.toLowerCase();
  const usdcAddress = tokens.usdc.toLowerCase();

  for (const log of receipt.logs) {
    const contractAddress = log.address.toLowerCase();

    // Check if this log is from a known stablecoin
    let token: "usdt" | "usdc" | null = null;
    if (contractAddress === usdtAddress) token = "usdt";
    else if (contractAddress === usdcAddress) token = "usdc";
    else continue;

    // Check if it matches the Transfer event signature
    if (log.topics[0] !== "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") {
      continue;
    }

    // Decode Transfer event: topics[1] = from, topics[2] = to, data = value
    if (!log.topics[1] || !log.topics[2]) continue;

    const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
    if (to !== recipientWallet) continue;

    const from = "0x" + log.topics[1].slice(26);
    const value = BigInt(log.data);
    const amountUsd = Number(formatUnits(value, 6));

    return {
      from,
      to,
      amountRaw: value.toString(),
      amountUsd,
      token,
      blockNumber: Number(receipt.blockNumber),
      txHash,
    };
  }

  return null;
}

/**
 * Verify a transfer on any supported chain.
 * Dispatches to chain-specific verification functions.
 */
export async function verifyTransfer(
  txHash: string,
  chainId: ChainId,
  config: Config,
): Promise<VerifiedTransfer | null> {
  switch (chainId) {
    case "base":
    case "eth":
      return verifyEvmTransfer(txHash, chainId, config);
    case "ton":
      return verifyTonTransfer(txHash, config);
    case "sol":
      return verifySolTransfer(txHash, config);
    default:
      throw new Error(`Unsupported chain: ${chainId}`);
  }
}

/**
 * Resolve a USD amount to a plan ID.
 */
export function resolveplan(amountUsd: number, prices: Config["prices"]): string | null {
  // Allow 1% tolerance for exchange rate variance
  const tolerance = 0.01;
  if (Math.abs(amountUsd - prices.max) / prices.max <= tolerance) return "max";
  if (Math.abs(amountUsd - prices.pro) / prices.pro <= tolerance) return "pro";
  if (Math.abs(amountUsd - prices.starter) / prices.starter <= tolerance) return "starter";
  return null;
}
