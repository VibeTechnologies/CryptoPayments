import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// Static import: vi.mock is hoisted above this, so viem is already mocked.
// (A per-test dynamic import charged the ~1s viem load to each test timeout.)
import {
  fetchWithRetry,
  TransientVerificationError,
  verifyEvmTransfer,
  verifySolTransfer,
  verifyTonTransfer,
  verifyTransfer,
  withRpcFailover,
  type RetryClock,
} from "../src/verify.js";

/**
 * Virtual clock for retry/backoff tests: sleep() advances virtual time and
 * yields a microtask instead of waiting on a real timer, and random() is
 * deterministic. Keeps retry tests independent of host CPU load.
 */
function fakeClock(): RetryClock {
  let t = 0;
  return {
    now: () => t,
    async sleep(ms: number) {
      t += ms;
      await Promise.resolve();
    },
    random: () => 0.5,
  };
}

// ── resolveplan tests are in payments.test.ts already, but let's add
//    chain-specific verification tests with mocked fetch/viem ──

// vi.hoisted runs before vi.mock hoisting, so the ref is available in the factory
const { mockGetTransactionReceipt, mockGetBlockNumber } = vi.hoisted(() => ({
  mockGetTransactionReceipt: vi.fn(),
  mockGetBlockNumber: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      getTransactionReceipt: mockGetTransactionReceipt,
      getBlockNumber: mockGetBlockNumber,
    }),
  };
});

describe("verifyEvmTransfer", () => {
  beforeEach(() => {
    // Default: return a block number far ahead so the confirmation gate
    // passes for any reasonable blockNumber in the receipt.
    mockGetBlockNumber.mockResolvedValue(1_000_000n);
  });

  afterEach(() => {
    mockGetTransactionReceipt.mockReset();
    mockGetBlockNumber.mockReset();
  });

  it("returns null for reverted transaction", async () => {
    mockGetTransactionReceipt.mockResolvedValue({
      status: "reverted",
      logs: [],
    });

    const config = makeConfig();
    const result = await verifyEvmTransfer("0xabc", "base", config);
    expect(result).toBeNull();
  });

  it("retries (does not immediately treat as no-match) a null receipt from a lagging RPC node, then succeeds", async () => {
    // AGE-970: some RPC providers resolve getTransactionReceipt with `null`
    // (rather than throwing) when their own node is behind chain tip. That
    // must be treated as transient/retryable, not a definitive answer.
    mockGetTransactionReceipt
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        status: "success",
        blockNumber: 12345n,
        logs: [],
      });

    const config = makeConfig();
    const clock = fakeClock();
    const result = await verifyEvmTransfer("0xabc", "base", config, { clock });
    // No matching Transfer log in the (eventually real) receipt => null, but
    // critically we got there via retry, not an immediate short-circuit.
    expect(result).toBeNull();
    expect(mockGetTransactionReceipt).toHaveBeenCalledTimes(3);
    // verifyEvmTransfer must forward opts.clock into withRpcFailover: the two
    // in-endpoint backoffs (300ms + 600ms) land on the virtual clock.
    expect(clock.now()).toBe(900);
  });

  it("returns null when no matching Transfer log", async () => {
    mockGetTransactionReceipt.mockResolvedValue({
      status: "success",
      blockNumber: 12345n,
      logs: [
        {
          address: "0x0000000000000000000000000000000000000000",
          topics: [
            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            "0x0000000000000000000000001111111111111111111111111111111111111111",
            "0x0000000000000000000000002222222222222222222222222222222222222222",
          ],
          data: "0x0000000000000000000000000000000000000000000000000000000000989680",
        },
      ],
    });

    const config = makeConfig();
    const result = await verifyEvmTransfer("0xabc", "base", config);
    expect(result).toBeNull();
  });

  it("returns verified transfer for matching USDC Transfer to our wallet", async () => {
    const ourWallet = "0xOurWalletAddress000000000000000000000001";
    const ourWalletPadded =
      "0x000000000000000000000000" +
      ourWallet.slice(2).toLowerCase();

    mockGetTransactionReceipt.mockResolvedValue({
      status: "success",
      blockNumber: 99999n,
      logs: [
        {
          // USDC on Base
          address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          topics: [
            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            "0x0000000000000000000000001111111111111111111111111111111111111111",
            ourWalletPadded,
          ],
          data: "0x0000000000000000000000000000000000000000000000000000000000989680", // 10_000_000 = 10 USDC
        },
      ],
    });

    const config = makeConfig({ base: ourWallet });
    const result = await verifyEvmTransfer("0xtxhash", "base", config);

    expect(result).not.toBeNull();
    expect(result!.token).toBe("usdc");
    expect(result!.amountUsd).toBe(10);
    expect(result!.blockNumber).toBe(99999);
    expect(result!.to.toLowerCase()).toBe(ourWallet.toLowerCase());
  });
  it("returns verified transfer for matching USDC Transfer on base_sepolia", async () => {
    const ourWallet = "0xOurWalletAddress000000000000000000000001";
    const ourWalletPadded =
      "0x000000000000000000000000" +
      ourWallet.slice(2).toLowerCase();

    mockGetTransactionReceipt.mockResolvedValue({
      status: "success",
      blockNumber: 11111n,
      logs: [
        {
          // USDC on Base Sepolia (Circle testnet)
          address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          topics: [
            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            "0x0000000000000000000000001111111111111111111111111111111111111111",
            ourWalletPadded,
          ],
          data: "0x0000000000000000000000000000000000000000000000000000000000989680", // 10_000_000 = 10 USDC
        },
      ],
    });

    const config = makeConfig({ base_sepolia: ourWallet });
    const result = await verifyEvmTransfer("0xsepoliatx", "base_sepolia", config);

    expect(result).not.toBeNull();
    expect(result!.token).toBe("usdc");
    expect(result!.amountUsd).toBe(10);
    expect(result!.blockNumber).toBe(11111);
    expect(result!.to.toLowerCase()).toBe(ourWallet.toLowerCase());
  });
});

describe("verifyTonTransfer", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when transaction not found", async () => {
    const mockFetch = vi.mocked(fetch);
    // First call: /transactions
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ transactions: [] }), { status: 200 }),
    );
    // Second call: /jetton/transfers
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ jetton_transfers: [] }), { status: 200 }),
    );

    const config = makeConfig();
    const result = await verifyTonTransfer("tonhash123", config);
    expect(result).toBeNull();
  });

  it("returns verified transfer for matching USDT jetton transfer", async () => {
    const mockFetch = vi.mocked(fetch);
    // Use a realistic mixed-case TON base64 address to verify we do NOT lowercase
    // (TON addresses are case-sensitive; lowercasing would corrupt them).
    const ourWallet = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";

    // First call: /transactions
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          transactions: [{ hash: "tonhash", lt: "12345", account: "sender" }],
        }),
        { status: 200 },
      ),
    );

    // Second call: /jetton/transfers
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jetton_transfers: [
            {
              query_id: "1",
              source: "EQSenderAddress",
              destination: ourWallet,
              amount: "25000000", // 25 USDT
              jetton_master: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",
              transaction_hash: "tonhash",
              transaction_lt: "12345",
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const config = makeConfig({ ton: ourWallet });
    const result = await verifyTonTransfer("tonhash", config);

    expect(result).not.toBeNull();
    expect(result!.token).toBe("usdt");
    expect(result!.amountUsd).toBe(25);
    expect(result!.to).toBe(ourWallet);
  });

  it("throws when jetton API fails (loud failure, not silent null)", async () => {
    const mockFetch = vi.mocked(fetch);

    // First call: /transactions — success
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          transactions: [{ hash: "tonhash", lt: "1", account: "x" }],
        }),
        { status: 200 },
      ),
    );

    // /jetton/transfers — persistent 5xx. AGE-960's bounded retry treats a
    // 5xx as transient and retries the SAME endpoint before giving up, so
    // this must keep answering 500 across every attempt, not just once.
    mockFetch.mockResolvedValue(new Response("Internal Server Error", { status: 500 }));

    const config = makeConfig();
    // Still a loud failure (never silently returns null) — now surfaced as a
    // TransientVerificationError after bounded retry, not an immediate throw.
    const clock = fakeClock();
    let caught: unknown;
    try {
      await verifyTonTransfer("tonhash", config, { clock });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TransientVerificationError);
    expect((caught as Error).message).toMatch(/500/);
  });
});

describe("verifySolTransfer", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null for failed transaction", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: { slot: 100, meta: { err: { InstructionError: [0, "Custom"] } } },
        }),
        { status: 200 },
      ),
    );

    const config = makeConfig();
    const result = await verifySolTransfer("solhash", config);
    expect(result).toBeNull();
  });

  it("returns null when no matching SPL token transfer", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: {
            slot: 100,
            meta: { err: null, preTokenBalances: [], postTokenBalances: [], innerInstructions: [] },
            transaction: {
              message: {
                accountKeys: [{ pubkey: "SomeKey" }],
                instructions: [],
              },
            },
          },
        }),
        { status: 200 },
      ),
    );

    const config = makeConfig();
    const result = await verifySolTransfer("solhash", config);
    expect(result).toBeNull();
  });

  it("returns verified transfer for matching USDC SPL transfer", async () => {
    const ourWallet = "SolWalletPubkey123";
    const destAta = "DestAtaAddress";
    const mockFetch = vi.mocked(fetch);

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: {
            slot: 200,
            meta: {
              err: null,
              preTokenBalances: [],
              postTokenBalances: [
                {
                  accountIndex: 1,
                  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
                  owner: ourWallet,
                  uiTokenAmount: { amount: "10000000", decimals: 6, uiAmount: 10 },
                },
              ],
              innerInstructions: [],
            },
            transaction: {
              message: {
                accountKeys: [
                  { pubkey: "SenderAta" },
                  { pubkey: destAta },
                ],
                instructions: [
                  {
                    program: "spl-token",
                    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                    parsed: {
                      type: "transferChecked",
                      info: {
                        authority: "SenderWallet",
                        source: "SenderAta",
                        destination: destAta,
                        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                        tokenAmount: { amount: "10000000", decimals: 6, uiAmount: 10 },
                      },
                    },
                  },
                ],
              },
            },
          },
        }),
        { status: 200 },
      ),
    );

    const config = makeConfig({ sol: ourWallet });
    const result = await verifySolTransfer("solhash", config);

    expect(result).not.toBeNull();
    expect(result!.token).toBe("usdc");
    expect(result!.amountUsd).toBe(10);
    expect(result!.to).toBe(ourWallet);
    expect(result!.blockNumber).toBe(200);
  });
});

describe("verifyTransfer dispatcher", () => {
  it("throws for unsupported chain", async () => {
    const config = makeConfig();
    await expect(
      verifyTransfer("0x123", "xyz" as any, config),
    ).rejects.toThrow("Unsupported chain");
  });
});

// ── withRpcFailover (AGE-960 / GH#49: single-RPC SPOF, no failover/retry) ────

describe("withRpcFailover", () => {
  it("retries the same endpoint on a transient error, then succeeds", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await withRpcFailover(["https://a"], async (url) => {
      calls++;
      if (calls < 2) throw new Error("ETIMEDOUT");
      return `ok:${url}`;
    }, { clock });
    expect(result).toBe("ok:https://a");
    expect(calls).toBe(2);
  });

  it("fails over to the next endpoint once the first is exhausted", async () => {
    const clock = fakeClock();
    const attempted: string[] = [];
    const result = await withRpcFailover(["https://a", "https://b"], async (url) => {
      attempted.push(url);
      if (url === "https://a") throw new Error("fetch failed: connect ETIMEDOUT");
      return `ok:${url}`;
    }, { clock });
    expect(result).toBe("ok:https://b");
    // 3 attempts against "a" (all transient) before failing over to "b".
    expect(attempted.filter((u) => u === "https://a").length).toBe(3);
    expect(attempted.filter((u) => u === "https://b").length).toBe(1);
  });

  it("rethrows a non-transient error immediately — no retry, no failover", async () => {
    const clock = fakeClock();
    let calls = 0;
    await expect(
      withRpcFailover(["https://a", "https://b"], async () => {
        calls++;
        throw new Error("No wallet configured for chain eth");
      }, { clock }),
    ).rejects.toThrow("No wallet configured");
    expect(calls).toBe(1);
    expect(clock.now()).toBe(0); // no backoff slept
  });

  it("throws TransientVerificationError (never a bare Error) once every endpoint is exhausted", async () => {
    const clock = fakeClock();
    await expect(
      withRpcFailover(["https://a", "https://b"], async () => {
        throw new Error("network timeout");
      }, { clock }),
    ).rejects.toBeInstanceOf(TransientVerificationError);
    // Single pass: 300ms + 600ms in-endpoint backoff per endpoint, no sweep.
    expect(clock.now()).toBe(1_800);
  });

  it("retry path performs no real waiting when a clock is injected", async () => {
    // Deterministic guard: pass-through spies prove the retry path never
    // touches the real timer/clock/RNG when a clock is injected. A wall-clock
    // threshold alone is flaky under CPU load, so it is only a loose sanity
    // bound here (a real-sleep regression would take >= 90s).
    const clock = fakeClock();
    // Silence the [RPC-RETRY]/[RPC-SWEEP] logs: vitest's console capture
    // calls Date.now() once per logged line (to timestamp it), which is
    // test-harness noise, not the retry path reading the real clock.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const st = vi.spyOn(globalThis, "setTimeout");
    const dn = vi.spyOn(Date, "now");
    const mr = vi.spyOn(Math, "random");
    try {
      const w0 = performance.now();
      const v0 = clock.now();
      await expect(
        withRpcFailover(["https://a", "https://b"], async () => {
          throw new Error("ETIMEDOUT");
        }, { totalBudgetMs: 90_000, clock }),
      ).rejects.toThrow(TransientVerificationError);
      expect(st).not.toHaveBeenCalled();
      expect(dn).not.toHaveBeenCalled();
      expect(mr).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalled(); // the retry/sweep path actually ran
      expect(clock.now() - v0).toBeGreaterThanOrEqual(90_000);
      expect(performance.now() - w0).toBeLessThan(10_000);
    } finally {
      st.mockRestore();
      dn.mockRestore();
      mr.mockRestore();
      log.mockRestore();
    }
  });

  it("fetchWithRetry retries a transient 5xx on the same URL before succeeding", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(new Response("boom", { status: 503 }));
    mockFetch.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const clock = fakeClock();
    const resp = await fetchWithRetry("https://ton.example/api", undefined, { clock });
    expect(resp.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ── Sweep layer (AGE-970: re-sweep the whole endpoint list with backoff
//    instead of giving up after a single failed pass) ──

describe("withRpcFailover sweep layer (opts.totalBudgetMs)", () => {
  it("survives N consecutive full-pass transient failures then succeeds on a later sweep", async () => {
    const clock = fakeClock();
    let calls = 0;
    // 2 endpoints x 3 attempts = 6 transient failures burns through the
    // first full pass entirely; succeed only once we reach the second sweep.
    const FAILURES_BEFORE_SUCCESS = 7;
    const result = await withRpcFailover(
      ["https://a", "https://b"],
      async (url) => {
        calls++;
        if (calls <= FAILURES_BEFORE_SUCCESS) throw new Error("ETIMEDOUT");
        return `ok:${url}:${calls}`;
      },
      { totalBudgetMs: 20_000, chainId: "base", clock },
    );
    expect(result).toBe(`ok:https://a:${FAILURES_BEFORE_SUCCESS + 1}`);
    // Proves a full first pass (6 calls) was exhausted and a second sweep
    // actually re-tried the list from the top (call #7 succeeding on "a"
    // again, not just retried within one endpoint).
    expect(calls).toBe(FAILURES_BEFORE_SUCCESS + 1);
    // Virtual time: full first pass (2 x (300 + 600)ms) + one jittered sweep
    // delay (0.5 x 250ms cap) + one 300ms in-endpoint retry on sweep 2.
    expect(clock.now()).toBe(2_225);
  });

  it("logs an [RPC-SWEEP] line with an observed delay before re-sweeping", async () => {
    const clock = fakeClock();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let calls = 0;
    await withRpcFailover(
      ["https://a"],
      async () => {
        calls++;
        if (calls <= 3) throw new Error("ETIMEDOUT"); // exhausts the one endpoint's pass
        return "ok";
      },
      { totalBudgetMs: 15_000, chainId: "eth", clock },
    );
    const sweepLines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[RPC-SWEEP]"));
    expect(sweepLines.length).toBeGreaterThanOrEqual(1);
    expect(sweepLines[0]).toMatch(/chain=eth sweep=1 delayMs=\d+/);
    // Full-jitter delay must be a real, bounded, non-negative number — not a
    // fixed constant — so we assert on the observed value's range instead of
    // an exact figure.
    const observedDelay = Number(sweepLines[0].match(/delayMs=(\d+)/)?.[1]);
    expect(observedDelay).toBeGreaterThanOrEqual(0);
    expect(observedDelay).toBeLessThanOrEqual(250);
    logSpy.mockRestore();
  });

  it("without opts.totalBudgetMs, throws after ONE pass — no sweep budget burned", async () => {
    const clock = fakeClock();
    let calls = 0;
    await expect(
      withRpcFailover(["https://a"], async () => {
        calls++;
        throw new Error("ETIMEDOUT");
      }, { clock }),
    ).rejects.toBeInstanceOf(TransientVerificationError);
    // 3 attempts against the single endpoint, no re-sweep — pre-AGE-970
    // behavior preserved exactly for callers that don't opt in.
    expect(calls).toBe(3);
    // Only the in-endpoint backoff (300ms + 600ms) — no sweep delay.
    expect(clock.now()).toBe(900);
  });

  it("a genuine non-transient error (tx not found) short-circuits immediately — never burns sweep budget", async () => {
    const clock = fakeClock();
    let calls = 0;
    await expect(
      withRpcFailover(
        ["https://a", "https://b"],
        async () => {
          calls++;
          throw new Error("Transaction receipt with hash ... could not be found");
        },
        { totalBudgetMs: 90_000, chainId: "base", clock }, // cron-sized budget — must NOT be consumed
      ),
    ).rejects.toThrow(/could not be found/);
    expect(calls).toBe(1); // no retry, no failover, no sweep
    expect(clock.now()).toBe(0); // zero budget consumed
  });
});

// ── Helper: build a Config object for testing ──

function makeConfig(wallets?: Partial<Record<string, string>>) {
  return {
    port: 3003,
    supabaseUrl: "https://test.supabase.co",
    supabaseKey: "test-key",
    wallets: {
      base: wallets?.base ?? "0xTestBaseWallet",
      eth: wallets?.eth ?? "0xTestEthWallet",
      ton: wallets?.ton ?? "EQTestTonWallet",
      sol: wallets?.sol ?? "TestSolWallet",
      base_sepolia: wallets?.base_sepolia ?? wallets?.base ?? "0xTestBaseWallet",
    },
    rpc: {
      base: ["https://mainnet.base.org"],
      eth: ["https://cloudflare-eth.com"],
      arbitrum: ["https://arb1.arbitrum.io/rpc"],
      sol: "https://api.mainnet-beta.solana.com",
      ton: "https://toncenter.com/api/v3",
      base_sepolia: ["https://sepolia.base.org"],
      eth_sepolia: ["https://ethereum-sepolia-rpc.publicnode.com"],
    },
    prices: { starter: 10, pro: 25, max: 100 },
    telegramBotToken: "",
    apiKey: "",
    callbackSecret: "",
    baseUrl: "https://pay.openclaw.ai",
  };
}
