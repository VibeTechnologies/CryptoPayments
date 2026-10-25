import { describe, it, expect, vi } from "vitest";

import {
  pollPaymentVerified,
  formatElapsed,
  FAST_INTERVAL_MS,
  SLOW_INTERVAL_MS,
  BACKGROUND_INTERVAL_MS,
  MAIN_WINDOW_MS,
  BACKGROUND_WINDOW_MS,
  DEFAULT_FAILED_MESSAGE,
  type PollDeps,
} from "@/lib/poll-payment";
import type { PaymentResult } from "@/lib/config";

// ---------------------------------------------------------------------------
// Harness: simulated clock. `sleep` records the requested delay, advances a
// fake clock and resolves immediately, so a 40-minute schedule runs instantly.
// ---------------------------------------------------------------------------

type Script = (clockMs: number, callCount: number) => PaymentResult;

function makePayment(
  status: "pending" | "verified" | "failed",
  extra: Partial<PaymentResult["payment"]> = {},
): PaymentResult["payment"] {
  return {
    id: "pay_1",
    status,
    amount_usd: 10,
    token: "usdc",
    chain_id: "base",
    plan_id: "starter",
    topup_id: null,
    tx_hash: "0xdeadbeef",
    ...extra,
  };
}

function createHarness(script: Script) {
  const delays: number[] = [];
  const state = { clockMs: 0, calls: 0 };

  const deps: PollDeps = {
    checkPaymentStatus: async () => {
      state.calls += 1;
      return script(state.clockMs, state.calls);
    },
    sleep: async (ms: number) => {
      delays.push(ms);
      state.clockMs += ms;
    },
    onPending: vi.fn(),
    onVerified: vi.fn(),
    onFailed: vi.fn(),
    onTimeout: vi.fn(),
  };

  return { deps, delays, state };
}

/** Number of polls performed in the full main window (20 fast + 54 slow). */
const MAIN_WINDOW_POLLS =
  60_000 / FAST_INTERVAL_MS + (MAIN_WINDOW_MS - 60_000) / SLOW_INTERVAL_MS;
/** Number of polls in the full background window (60 x 30s). */
const BACKGROUND_POLLS = BACKGROUND_WINDOW_MS / BACKGROUND_INTERVAL_MS;

describe("pollPaymentVerified", () => {
  it("keeps polling well past the old 90s window — verifies at ~5 minutes (regression: MAX_ATTEMPTS=30)", async () => {
    const FIVE_MIN = 5 * 60_000;
    const h = createHarness((clockMs) =>
      clockMs >= FIVE_MIN
        ? { payment: makePayment("verified") }
        : { payment: makePayment("pending") },
    );

    await pollPaymentVerified("pay_1", h.deps);

    expect(h.deps.onVerified).toHaveBeenCalledTimes(1);
    expect(h.deps.onVerified).toHaveBeenCalledWith(
      expect.objectContaining({ status: "verified" }),
    );
    expect(h.deps.onTimeout).not.toHaveBeenCalled();
    expect(h.deps.onFailed).not.toHaveBeenCalled();
    // The old implementation gave up after 30 x 3s = 90s.
    expect(h.state.clockMs).toBe(FIVE_MIN);
    expect(h.state.calls).toBeGreaterThan(30);
  });

  it("uses 3s intervals for the first minute, then 10s, then 30s in the background phase", async () => {
    const h = createHarness(() => ({ payment: makePayment("pending") }));

    await pollPaymentVerified("pay_1", h.deps);

    const fast = h.delays.slice(0, 20);
    const slow = h.delays.slice(20, MAIN_WINDOW_POLLS);
    const background = h.delays.slice(MAIN_WINDOW_POLLS);

    expect(fast).toHaveLength(20);
    expect(new Set(fast)).toEqual(new Set([FAST_INTERVAL_MS]));
    // 20 x 3s covers exactly the first minute.
    expect(fast.reduce((a, b) => a + b, 0)).toBe(60_000);

    expect(slow).toHaveLength(54);
    expect(new Set(slow)).toEqual(new Set([SLOW_INTERVAL_MS]));

    expect(background).toHaveLength(BACKGROUND_POLLS);
    expect(new Set(background)).toEqual(new Set([BACKGROUND_INTERVAL_MS]));

    expect(h.state.clockMs).toBe(MAIN_WINDOW_MS + BACKGROUND_WINDOW_MS);
  });

  it("reports cumulative elapsed time to onPending on every pending poll", async () => {
    const h = createHarness((clockMs) =>
      clockMs >= 90_000
        ? { payment: makePayment("verified") }
        : { payment: makePayment("pending") },
    );

    await pollPaymentVerified("pay_1", h.deps);

    const elapsed = vi.mocked(h.deps.onPending).mock.calls.map(([ms]) => ms);
    expect(elapsed.slice(0, 3)).toEqual([3_000, 6_000, 9_000]);
    expect(elapsed.at(-1)).toBe(80_000); // last pending before the 90s verify
  });

  it("fires onTimeout once after the 10-minute main window but keeps polling — a ~15 min verification still wins", async () => {
    const FIFTEEN_MIN = 15 * 60_000;
    const h = createHarness((clockMs) =>
      clockMs >= FIFTEEN_MIN
        ? { payment: makePayment("verified") }
        : { payment: makePayment("pending") },
    );

    await pollPaymentVerified("pay_1", h.deps);

    expect(h.deps.onTimeout).toHaveBeenCalledTimes(1);
    expect(h.deps.onVerified).toHaveBeenCalledTimes(1);
    expect(h.state.clockMs).toBe(FIFTEEN_MIN);
    // Timeout fired at the 10-min boundary, 10 more background polls followed.
    expect(h.delays).toHaveLength(MAIN_WINDOW_POLLS + 10);
  });

  it("stops on a failed status during the main window and reports the server error", async () => {
    const h = createHarness((_clockMs, calls) =>
      calls >= 3
        ? { payment: makePayment("failed"), error: "Transaction reverted on-chain." }
        : { payment: makePayment("pending") },
    );

    await pollPaymentVerified("pay_1", h.deps);

    expect(h.deps.onFailed).toHaveBeenCalledTimes(1);
    expect(h.deps.onFailed).toHaveBeenCalledWith("Transaction reverted on-chain.");
    expect(h.deps.onVerified).not.toHaveBeenCalled();
    expect(h.deps.onTimeout).not.toHaveBeenCalled();
    expect(h.state.calls).toBe(3);
    expect(h.state.clockMs).toBe(9_000);
  });

  it("falls back to the default message when a failed status carries no server error", async () => {
    const h = createHarness(() => ({ payment: makePayment("failed") }));

    await pollPaymentVerified("pay_1", h.deps);

    expect(h.deps.onFailed).toHaveBeenCalledWith(DEFAULT_FAILED_MESSAGE);
  });

  it("stops on a failed status during the background phase WITHOUT overwriting the visible timeout error", async () => {
    // The poll at exactly MAIN_WINDOW_MS is still the *last main-window* poll,
    // so fail only strictly after it — i.e. on the first background poll.
    const h = createHarness((clockMs) =>
      clockMs > MAIN_WINDOW_MS
        ? { payment: makePayment("failed"), error: "Transaction reverted on-chain." }
        : { payment: makePayment("pending") },
    );

    await pollPaymentVerified("pay_1", h.deps);

    expect(h.deps.onTimeout).toHaveBeenCalledTimes(1);
    expect(h.deps.onFailed).not.toHaveBeenCalled();
    expect(h.deps.onVerified).not.toHaveBeenCalled();
    // One background poll, then the loop stopped.
    expect(h.delays).toHaveLength(MAIN_WINDOW_POLLS + 1);
  });

  it("gives up after the background window when nothing ever verifies", async () => {
    const h = createHarness(() => ({ payment: makePayment("pending") }));

    await pollPaymentVerified("pay_1", h.deps);

    expect(h.deps.onTimeout).toHaveBeenCalledTimes(1);
    expect(h.deps.onVerified).not.toHaveBeenCalled();
    expect(h.deps.onFailed).not.toHaveBeenCalled();
    expect(h.state.calls).toBe(MAIN_WINDOW_POLLS + BACKGROUND_POLLS);
  });

  it("verifies immediately on the first poll", async () => {
    const h = createHarness(() => ({ payment: makePayment("verified") }));

    await pollPaymentVerified("pay_1", h.deps);

    expect(h.state.calls).toBe(1);
    expect(h.delays).toEqual([FAST_INTERVAL_MS]);
    expect(h.deps.onPending).not.toHaveBeenCalled();
    expect(h.deps.onVerified).toHaveBeenCalledTimes(1);
  });

  it("propagates checkPaymentStatus errors to the caller", async () => {
    const h = createHarness(() => {
      throw new Error("Payment not found: 404");
    });

    await expect(pollPaymentVerified("pay_1", h.deps)).rejects.toThrow(
      "Payment not found: 404",
    );
    expect(h.deps.onTimeout).not.toHaveBeenCalled();
  });
});

describe("formatElapsed", () => {
  it("renders seconds under a minute", () => {
    expect(formatElapsed(3_000)).toBe("3s");
    expect(formatElapsed(59_000)).toBe("59s");
  });

  it("renders minutes and seconds at or past a minute", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(90_000)).toBe("1m 30s");
    expect(formatElapsed(600_000)).toBe("10m 0s");
  });
});
