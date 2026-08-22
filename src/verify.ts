import { createPublicClient, http, parseAbiItem, type Address, formatUnits } from "viem";
import { arbitrum, base, baseSepolia, mainnet, sepolia } from "viem/chains";
import type { ChainId, Config } from "./config.ts";
import { TOKEN_ADDRESSES } from "./config.ts";
import { recordRpcRetryAttempt, recordRpcExhaustion } from "./metrics.ts";

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

/**
 * Thrown when verification could not be COMPLETED (RPC timeout, network
 * error, 5xx, rate-limit) after exhausting bounded retry across every
 * configured endpoint. Callers must treat this as "try again later", never
 * as "payment failed" — a mined, correctly-paid transfer must not be
 * recorded as a negative verification result just because every free public
 * RPC endpoint happened to be slow tonight (AGE-960 / GH#49).
 */
export class TransientVerificationError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "TransientVerificationError";
  }
}

const RETRY_ATTEMPTS_PER_ENDPOINT = 3;
const RETRY_BASE_DELAY_MS = 300;
const RETRY_MAX_TOTAL_MS = 10_000;

/**
 * Delay schedule for the OUTER sweep layer (AGE-970): once a full pass over
 * every configured endpoint has failed transiently, wait and sweep the
 * entire list again rather than giving up after one pass. Base delays are
 * 250ms -> 500ms -> 1s -> 2s -> 4s (capped), each drawn with FULL jitter
 * (`random(0, cap)`, AWS "full jitter" strategy) so concurrent callers
 * (webhook + reconcile cron hitting the same flaky endpoint) don't retry in
 * lockstep.
 */
const SWEEP_BASE_DELAY_MS = 250;
const SWEEP_MAX_DELAY_MS = 4_000;

/**
 * Total wall-clock budget for the interactive webhook / lazy-poll paths
 * (POST /api/payment, GET /api/payment/:id) — a human or bot is blocked on
 * this HTTP request, so it stays comfortably under typical client/proxy
 * timeouts while still buying roughly one extra full sweep beyond the
 * original single-pass `RETRY_MAX_TOTAL_MS` ceiling.
 */
export const RPC_SWEEP_BUDGET_WEBHOOK_MS = 20_000;

/**
 * Total wall-clock budget for the unattended reconcile sweep
 * (POST /api/admin/reconcile, invoked from a cron / GitHub Actions
 * schedule). Nobody is blocked on this call synchronously, and a mined but
 * not-yet-visible-everywhere transfer is far more likely to show up within
 * a longer window, so this affords several sweeps per payment (~90s) before
 * giving up and leaving the row for the next scheduled run — still bounded
 * so one stubborn payment can't stall the whole batch indefinitely.
 */
export const RPC_SWEEP_BUDGET_CRON_MS = 90_000;

function isTransientRpcError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|fetch failed|abort|socket hang up|HeadersTimeoutError|UND_ERR|\b5\d\d\b|rate.?limit|too many requests|429|lagging/i.test(
    msg,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Run `fn(url)` against each RPC endpoint in `rpcUrls`, in order. Within one
 * endpoint, retry up to `RETRY_ATTEMPTS_PER_ENDPOINT` times with exponential
 * backoff on a transient-looking error before failing over to the next
 * endpoint.
 *
 * If `opts.totalBudgetMs` is passed, a full failed pass over every endpoint
 * does not give up immediately (AGE-970): it sleeps a jittered backoff
 * (`SWEEP_BASE_DELAY_MS` doubling, capped at `SWEEP_MAX_DELAY_MS`, full
 * jitter) and re-sweeps the whole endpoint list from the top, repeating
 * until `totalBudgetMs` elapses. Omitting `opts.totalBudgetMs` preserves the
 * original pre-AGE-970 behavior exactly: a single pass bounded by
 * `RETRY_MAX_TOTAL_MS`, then an immediate throw — existing callers/tests
 * that don't opt in are unaffected.
 *
 * A non-transient error (e.g. "tx not found", a hard revert signal, a
 * programming error) is rethrown immediately without retry, failover, or
 * sweep — that is a real, complete answer, not an infrastructure hiccup.
 *
 * If the budget is exhausted, throws `TransientVerificationError`.
 */
export async function withRpcFailover<T>(
  rpcUrls: string[],
  fn: (url: string) => Promise<T>,
  opts?: { totalBudgetMs?: number; chainId?: string },
): Promise<T> {
  if (rpcUrls.length === 0) {
    throw new Error("No RPC endpoints configured");
  }
  const sweepEnabled = opts?.totalBudgetMs !== undefined;
  const totalBudgetMs = opts?.totalBudgetMs ?? RETRY_MAX_TOTAL_MS;
  const chainLabel = opts?.chainId ?? "unknown";
  const start = Date.now();
  let lastErr: unknown;
  let sweep = 0;
  for (;;) {
    for (const url of rpcUrls) {
      for (let attempt = 1; attempt <= RETRY_ATTEMPTS_PER_ENDPOINT; attempt++) {
        try {
          return await fn(url);
        } catch (err) {
          lastErr = err;
          if (!isTransientRpcError(err)) throw err;
          recordRpcRetryAttempt(chainLabel);
          const elapsed = Date.now() - start;
          if (elapsed >= totalBudgetMs) break;
          if (attempt < RETRY_ATTEMPTS_PER_ENDPOINT) {
            const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), totalBudgetMs - elapsed);
            console.log(
              `[RPC-RETRY] chain=${chainLabel} endpoint=${url} attempt=${attempt}/${RETRY_ATTEMPTS_PER_ENDPOINT} delayMs=${delay}`,
            );
            await sleep(delay);
          }
        }
      }
    }
    if (!sweepEnabled) break;
    const elapsed = Date.now() - start;
    if (elapsed >= totalBudgetMs) break;
    sweep++;
    const cap = Math.min(SWEEP_BASE_DELAY_MS * 2 ** (sweep - 1), SWEEP_MAX_DELAY_MS);
    const delay = Math.random() * cap; // full jitter
    if (elapsed + delay >= totalBudgetMs) break;
    console.log(
      `[RPC-SWEEP] chain=${chainLabel} sweep=${sweep} delayMs=${Math.round(delay)} elapsedMs=${elapsed} budgetMs=${totalBudgetMs}`,
    );
    await sleep(delay);
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  recordRpcExhaustion(chainLabel);
  throw new TransientVerificationError(
    `All ${rpcUrls.length} RPC endpoint(s) failed after retry${sweep > 0 ? ` across ${sweep + 1} sweeps` : ""}: ${msg}`,
    lastErr,
  );
}

/**
 * `fetch` wrapped with the same bounded retry as `withRpcFailover`, for the
 * TON/SOL verification paths which call a single fetch-based API rather than
 * a viem client. No multi-endpoint failover here (single provider per
 * chain), but a timeout/network blip/5xx no longer surfaces as an immediate
 * throw into the terminal-failure catch in server.ts.
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  opts?: { totalBudgetMs?: number; chainId?: string },
): Promise<Response> {
  return withRpcFailover(
    [url],
    async (u) => {
      const resp = await fetch(u, { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) });
      if (resp.status >= 500 || resp.status === 429) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }
      return resp;
    },
    opts,
  );
}

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
  opts?: { totalBudgetMs?: number },
): Promise<VerifyResult> {
  const chain = chainId === "base_sepolia" ? baseSepolia
    : chainId === "eth_sepolia" ? sepolia
    : chainId === "base" ? base
    : chainId === "arbitrum" ? arbitrum
    : mainnet;
  const rpcUrls = chainId === "base_sepolia" ? config.rpc.base_sepolia
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

  const clientFor = (url: string) => createPublicClient({ chain, transport: http(url) });

  // Get transaction receipt — may throw if tx is not yet mined, or if the RPC
  // endpoint times out/errors (AGE-960: the latter must NOT be conflated with
  // "not yet mined" or bubble up as an unclassified throw — withRpcFailover
  // retries/fails-over first, then re-raises as TransientVerificationError).
  let receipt: Awaited<ReturnType<ReturnType<typeof clientFor>["getTransactionReceipt"]>>;
  try {
    receipt = await withRpcFailover(
      rpcUrls,
      async (url) => {
        const r = await clientFor(url).getTransactionReceipt({ hash: txHash as `0x${string}` });
        // Some RPC providers resolve with a null receipt (instead of throwing
        // "not found") when their own node is lagging behind chain tip, not
        // because the tx genuinely hasn't been seen anywhere. Treating that as
        // a definitive "no receipt" would misclassify a lagging node the same
        // as a real not-yet-mined tx and skip retry/failover entirely
        // (AGE-970). Force it through the same transient retry path instead.
        if (!r) {
          throw new Error("null transaction receipt (lagging RPC node)");
        }
        return r;
      },
      { totalBudgetMs: opts?.totalBudgetMs, chainId },
    );
  } catch (err) {
    if (err instanceof TransientVerificationError) throw err;
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
  const currentBlock = await withRpcFailover(
    rpcUrls,
    (url) => clientFor(url).getBlockNumber(),
    { totalBudgetMs: opts?.totalBudgetMs, chainId },
  );
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
  opts?: { totalBudgetMs?: number },
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

  const resp = await fetchWithRetry(url, {
    headers: { Accept: "application/json" },
  }, { totalBudgetMs: opts?.totalBudgetMs, chainId: "ton" });

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
  const jettonResp = await fetchWithRetry(jettonUrl, {
    headers: { Accept: "application/json" },
  }, { totalBudgetMs: opts?.totalBudgetMs, chainId: "ton" });

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
  opts?: { totalBudgetMs?: number },
): Promise<VerifiedTransfer | null> {
  const recipientWallet = config.wallets.sol;
  if (!recipientWallet) {
    throw new Error("No wallet configured for Solana");
  }

  // Solana JSON-RPC: getTransaction with jsonParsed encoding
  const resp = await fetchWithRetry(config.rpc.sol, {
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
  }, { totalBudgetMs: opts?.totalBudgetMs, chainId: "sol" });

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
  opts?: { totalBudgetMs?: number },
): Promise<VerifyResult> {
  switch (chainId) {
    case "base":
    case "eth":
    case "arbitrum":
    case "base_sepolia":
    case "eth_sepolia":
      return verifyEvmTransfer(txHash, chainId, config, opts);
    case "ton":
      return verifyTonTransfer(txHash, config, opts);
    case "sol":
      return verifySolTransfer(txHash, config, opts);
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
