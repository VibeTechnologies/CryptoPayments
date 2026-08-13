import { createPublicClient, http, parseAbiItem, type Address, formatUnits } from "viem";
import { arbitrum, base, baseSepolia, mainnet, sepolia } from "viem/chains";
import type { ChainId, Config } from "./config.ts";
import { TOKEN_ADDRESSES, productConfig } from "./config.ts";

/** ERC-20 Transfer event signature */
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

/**
 * Minimum on-chain confirmations required before marking a transfer verified.
 * Testnet values are 1 so the live E2E (1 mined block) still passes.
 */
const MIN_CONFIRMATIONS: Record<"base" | "eth" | "arbitrum" | "base_sepolia" | "eth_sepolia", number> = {
  eth: 12,
  base: 5,
  arbitrum: 5,
  base_sepolia: 1,
  eth_sepolia: 1,
};

/**
 * ERC-20 token decimal places. All current supported stablecoins use 6.
 * Add 18-decimal tokens here when they are onboarded — never hardcode 6 inline.
 */
const TOKEN_DECIMALS: Record<"usdt" | "usdc" | "ausd", number> = {
  usdt: 6,
  usdc: 6,
  ausd: 6,
};

export type VerifyResult = VerifiedTransfer | null | "pending";

export interface VerifiedTransfer {
  from: string;
  to: string;
  /** Raw token amount (integer string, 6 decimals) */
  amountRaw: string;
  /** Human-readable USD amount */
  amountUsd: number;
  /** Which token was transferred */
  token: "usdt" | "usdc" | "ausd";
  blockNumber: number;
  txHash: string;
}

/**
 * Verify an ERC-20 stablecoin transfer on Base or Ethereum.
 * Checks that the tx contains a Transfer event to our wallet for USDT or USDC.
 */
export async function verifyEvmTransfer(
  txHash: string,
  chainId: "base" | "eth" | "arbitrum" | "base_sepolia" | "eth_sepolia",
  config: Config,
): Promise<VerifyResult> {
  const chain = chainId === "base_sepolia" ? baseSepolia
    : chainId === "eth_sepolia" ? sepolia
    : chainId === "base" ? base
    : chainId === "arbitrum" ? arbitrum
    : mainnet;
  const rpcUrl = chainId === "base_sepolia" ? config.rpc.base_sepolia
    : chainId === "eth_sepolia" ? config.rpc.eth_sepolia
    : chainId === "base" ? config.rpc.base
    : chainId === "arbitrum" ? config.rpc.arbitrum
    : config.rpc.eth;
  const recipientWallet = (chainId === "base_sepolia" ? config.wallets.base_sepolia
    : chainId === "eth_sepolia" ? config.wallets.eth_sepolia
    : chainId === "base" ? config.wallets.base
    : chainId === "arbitrum" ? config.wallets.arbitrum
    : config.wallets.eth).toLowerCase();

  if (!recipientWallet) {
    throw new Error(`No wallet configured for chain ${chainId}`);
  }

  const client = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  // Get transaction receipt — may throw if tx is not yet mined
  let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>>;
  try {
    receipt = await client.getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/could not be found|not found/i.test(msg)) {
      return "pending";
    }
    throw err;
  }

  if (!receipt || receipt.status === "reverted") {
    return null;
  }

  // Confirmation-count gate: protect against block reorganisations.
  // Testnets use 1 so a freshly mined tx passes immediately.
  const currentBlock = await client.getBlockNumber();
  const confirmations = Number(currentBlock - receipt.blockNumber) + 1;
  if (confirmations < MIN_CONFIRMATIONS[chainId]) {
    return "pending"; // not yet confirmed — caller can retry
  }

  // Look for Transfer events to our wallet from known stablecoins
  const tokens = TOKEN_ADDRESSES[chainId];
  const usdtAddress = tokens.usdt.toLowerCase();
  const usdcAddress = tokens.usdc.toLowerCase();
  const ausdAddress = tokens.ausd?.toLowerCase() ?? "";

  for (const log of receipt.logs) {
    const contractAddress = log.address.toLowerCase();

    // Check if this log is from a known stablecoin
    let token: "usdt" | "usdc" | "ausd" | null = null;
    if (contractAddress === usdtAddress) token = "usdt";
    else if (contractAddress === usdcAddress) token = "usdc";
    else if (ausdAddress && contractAddress === ausdAddress) token = "ausd";
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
    const amountUsd = Number(formatUnits(value, TOKEN_DECIMALS[token]));

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
 * Verify a Jetton (USDT/USDC) transfer on TON.
 *
 * TON uses a unique architecture: Jetton transfers go through
 * a Jetton Wallet contract (not the master contract directly).
 * We use the TonCenter v3 API to look up the transaction and
 * check for internal transfer messages.
 */
export async function verifyTonTransfer(
  txHash: string,
  config: Config,
): Promise<VerifiedTransfer | null> {
  // TON base64 addresses are case-sensitive — do NOT lowercase.
  const recipientWallet = config.wallets.ton.trim();
  if (!recipientWallet) {
    throw new Error("No wallet configured for TON");
  }

  // TonCenter v3 API — get transaction by hash
  // The txHash for TON can be base64 or hex
  const apiBase = config.rpc.ton.replace(/\/+$/, "");
  const url = `${apiBase}/transactions?hash=${encodeURIComponent(txHash)}&limit=1`;

  const resp = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    throw new Error(`TON API error: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json() as {
    transactions?: Array<{
      hash: string;
      lt: string;
      account: string;
      in_msg?: {
        source?: string;
        destination?: string;
        value?: string;
        msg_data?: {
          body?: string;
          "@type"?: string;
        };
        message?: string;
      };
      out_msgs?: Array<{
        source?: string;
        destination?: string;
        value?: string;
        message?: string;
      }>;
    }>;
  };

  const txs = data.transactions;
  if (!txs || txs.length === 0) return null;

  const tx = txs[0];

  // For Jetton transfers on TON, the flow is:
  // 1. User calls transfer on their Jetton Wallet
  // 2. Their Jetton Wallet sends internal_transfer to recipient's Jetton Wallet
  // 3. Recipient's Jetton Wallet sends transfer_notification to the recipient
  //
  // We use the /jetton/transfers endpoint for easier parsing
  const jettonUrl = `${apiBase}/jetton/transfers?transaction_hash=${encodeURIComponent(txHash)}&limit=10`;
  const jettonResp = await fetch(jettonUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });

  if (!jettonResp.ok) {
    // Throw loudly so callers know the result is indeterminate, not "not found".
    throw new Error(`TON Jetton API error: ${jettonResp.status} ${jettonResp.statusText}`);
  }

  const jettonData = await jettonResp.json() as {
    jetton_transfers?: Array<{
      query_id: string;
      source: string;
      destination: string;
      amount: string;
      jetton_master: string;
      transaction_hash: string;
      transaction_lt: string;
    }>;
  };

  const transfers = jettonData.jetton_transfers;
  if (!transfers || transfers.length === 0) return null;

  const usdtMaster = TOKEN_ADDRESSES.ton.usdt.toLowerCase();
  const usdcMaster = TOKEN_ADDRESSES.ton.usdc.toLowerCase();

  for (const transfer of transfers) {
    const jettonMaster = transfer.jetton_master?.toLowerCase() ?? "";
    let token: "usdt" | "usdc" | "ausd" | null = null;
    if (jettonMaster === usdtMaster) token = "usdt";
    else if (jettonMaster === usdcMaster) token = "usdc";
    else continue;

    // TON base64 addresses are case-sensitive — compare raw (no toLowerCase).
    const dest = transfer.destination?.trim() ?? "";
    if (dest !== recipientWallet) continue;

    // TON USDT/USDC are 6 decimals
    const amountRaw = transfer.amount;
    const amountUsd = Number(amountRaw) / 1e6;

    return {
      from: transfer.source,
      to: transfer.destination,
      amountRaw,
      amountUsd,
      token,
      blockNumber: Number(transfer.transaction_lt),
      txHash,
    };
  }

  return null;
}

/**
 * Verify a SPL Token (USDT/USDC) transfer on Solana.
 *
 * Uses Solana JSON-RPC getTransaction to fetch the parsed transaction
 * and scan for SPL Token Transfer instructions.
 */
export async function verifySolTransfer(
  txHash: string,
  config: Config,
): Promise<VerifiedTransfer | null> {
  const recipientWallet = config.wallets.sol;
  if (!recipientWallet) {
    throw new Error("No wallet configured for Solana");
  }

  // Solana JSON-RPC: getTransaction with jsonParsed encoding
  const resp = await fetch(config.rpc.sol, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        txHash,
        {
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
          commitment: "finalized",
        },
      ],
    }),
  });

  if (!resp.ok) {
    throw new Error(`Solana RPC error: ${resp.status} ${resp.statusText}`);
  }

  const rpcResult = await resp.json() as {
    result?: {
      slot: number;
      meta?: {
        err: unknown;
        preTokenBalances?: TokenBalance[];
        postTokenBalances?: TokenBalance[];
        innerInstructions?: Array<{
          index: number;
          instructions: SplInstruction[];
        }>;
      };
      transaction?: {
        message?: {
          accountKeys?: Array<{ pubkey: string }>;
          instructions?: SplInstruction[];
        };
      };
    };
  };

  const tx = rpcResult.result;
  if (!tx || tx.meta?.err) return null;

  // Build account keys array for mapping accountIndex → address
  const accountKeys = tx.transaction?.message?.accountKeys?.map(k => k.pubkey) ?? [];

  // Collect all SPL Token instructions: top-level + inner (CPI)
  const topLevel = tx.transaction?.message?.instructions ?? [];
  const innerLevel = tx.meta?.innerInstructions?.flatMap(ii => ii.instructions) ?? [];
  const allInstructions = [...topLevel, ...innerLevel];

  const usdtMint = TOKEN_ADDRESSES.sol.usdt;
  const usdcMint = TOKEN_ADDRESSES.sol.usdc;

  // Look for SPL Token transfer/transferChecked instructions
  for (const ix of allInstructions) {
    if (ix.program !== "spl-token" && ix.programId !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
      continue;
    }

    const parsed = ix.parsed;
    if (!parsed) continue;

    if (parsed.type !== "transfer" && parsed.type !== "transferChecked") {
      continue;
    }

    const info = parsed.info;
    if (!info) continue;

    // For SPL Token transfers, destination is a token account (ATA), not the wallet directly.
    // We need to check postTokenBalances to find which wallet owns the destination ATA.
    const destAta = info.destination;
    const mint = info.mint ?? findMintForAccount(tx.meta?.postTokenBalances, accountKeys, destAta);

    let token: "usdt" | "usdc" | "ausd" | null = null;
    if (mint === usdtMint) token = "usdt";
    else if (mint === usdcMint) token = "usdc";
    else continue;

    // Check if the destination ATA belongs to our wallet
    const destOwner = findOwnerForAccount(tx.meta?.postTokenBalances, accountKeys, destAta);
    if (destOwner !== recipientWallet) continue;

    // Extract amount (6 decimals for both USDT and USDC on Solana)
    let amountRaw: string;
    let amountUsd: number;

    if (info.tokenAmount) {
      amountRaw = info.tokenAmount.amount;
      amountUsd = info.tokenAmount.uiAmount;
    } else if (info.amount) {
      amountRaw = info.amount;
      amountUsd = Number(amountRaw) / 1e6;
    } else {
      continue;
    }

    // Find source wallet owner
    const sourceOwner = findOwnerForAccount(tx.meta?.preTokenBalances, accountKeys, info.source) ?? info.authority ?? info.source ?? "unknown";

    return {
      from: sourceOwner,
      to: recipientWallet,
      amountRaw,
      amountUsd,
      token,
      blockNumber: tx.slot,
      txHash,
    };
  }

  return null;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number };
}

interface SplInstruction {
  program?: string;
  programId?: string;
  parsed?: {
    type?: string;
    info?: {
      authority?: string;
      source?: string;
      destination?: string;
      amount?: string;
      tokenAmount?: { amount: string; decimals: number; uiAmount: number };
      mint?: string;
    };
  };
}

/**
 * Find the mint address for a token account by matching its address
 * against the accountKeys array using balance entry indexes.
 */
function findMintForAccount(
  balances: TokenBalance[] | undefined,
  accountKeys: string[],
  accountAddress: string | undefined,
): string | undefined {
  if (!balances || !accountAddress || accountKeys.length === 0) return undefined;
  for (const b of balances) {
    if (accountKeys[b.accountIndex] === accountAddress) {
      return b.mint;
    }
  }
  return undefined;
}

/**
 * Find the wallet owner of a token account (ATA) by matching its address
 * against the accountKeys array using balance entry indexes.
 */
function findOwnerForAccount(
  balances: TokenBalance[] | undefined,
  accountKeys: string[],
  accountAddress: string | undefined,
): string | undefined {
  if (!balances || !accountAddress || accountKeys.length === 0) return undefined;
  for (const b of balances) {
    if (accountKeys[b.accountIndex] === accountAddress) {
      return b.owner;
    }
  }
  return undefined;
}

/**
 * Verify a transfer on any supported chain.
 * Dispatches to chain-specific verification functions.
 */
export async function verifyTransfer(
  txHash: string,
  chainId: ChainId,
  config: Config,
): Promise<VerifyResult> {
  switch (chainId) {
    case "base":
    case "eth":
    case "arbitrum":
    case "base_sepolia":
    case "eth_sepolia":
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
 * Resolve a USD amount to a plan ID **within one product's price table**.
 *
 * Amount alone is NOT a globally unique key once more than one product exists:
 * two products may price different plans identically, or price the same plan
 * differently. So callers must scope the lookup. Pass either a bare price table
 * or `(config, product)` — the latter resolves the product's own table and
 * falls back to `openclaw` for an absent/unknown product.
 */
export function resolveplan(
  amountUsd: number,
  source: Config["prices"] | Config,
  product?: string | null,
): string | null {
  const prices: Config["prices"] = "products" in source
    ? productConfig(source as Config, product).prices
    : (source as Config["prices"]);
  // Allow 1% tolerance for exchange rate variance.
  //
  // The table is an OPEN map, so only the plans THIS product actually declares
  // are candidates. A product that sells `pro`/`max` has no `starter` entry and
  // therefore can never resolve to `"starter"` for any amount — including
  // openclaw's `starter` price. Previously the table was a fixed struct, every
  // product inherited `starter`, and a $10 vibe payment resolved to a plan the
  // consumer rejects as `unknown_plan` (with no callback retry, so the money
  // was taken and nothing delivered).
  //
  // Descending price order preserves the previous max -> pro -> starter
  // precedence. `validatePriceTable` rejects tables whose bands overlap, so at
  // most one plan can match and the order is not load-bearing for correctness.
  const tolerance = 0.01;
  const candidates = Object.entries(prices)
    .filter(([, price]) => Number.isFinite(price) && price > 0)
    .sort(([, a], [, b]) => b - a);
  for (const [plan, price] of candidates) {
    if (Math.abs(amountUsd - price) / price <= tolerance) return plan;
  }
  return null;
}
