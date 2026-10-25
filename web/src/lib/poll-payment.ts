// Client-side polling for lazy server-side payment verification.
//
// On-chain txs can take minutes to mine (observed 4m24s on Sepolia), and the
// backend verifies lazily on GET /api/payment/:id — if the client stops
// polling, the payment never verifies server-side and the provisioning
// callback never fires (prod bug OpenClawBot#3220). So:
//   - main window: 3s interval for the first minute, then 10s, up to 10 min;
//   - after 10 min surface the "taking longer" error BUT keep a slow
//     background poll (every 30s, up to 30 more minutes) so a late-mined tx
//     still flips to verified and triggers the callback.
//
// Kept free of React so the schedule is unit-testable with an injected clock.

import type { PaymentResult } from "./config";

export type Payment = PaymentResult["payment"];

/** Poll interval during the first minute of the main window. */
export const FAST_INTERVAL_MS = 3_000;
/** Poll interval for the rest of the main window. */
export const SLOW_INTERVAL_MS = 10_000;
/** Poll interval during the background phase (after the timeout error). */
export const BACKGROUND_INTERVAL_MS = 30_000;
/** How long the fast interval is used for. */
export const FAST_WINDOW_MS = 60_000;
/** Foreground window — user is watching the spinner. */
export const MAIN_WINDOW_MS = 10 * 60_000;
/** Background window — error is already shown, keep verifying quietly. */
export const BACKGROUND_WINDOW_MS = 30 * 60_000;

export const TIMEOUT_MESSAGE =
  "Transaction is taking longer than expected. Check back in a few minutes.";
export const DEFAULT_FAILED_MESSAGE =
  "Verification failed. Payment not found on-chain.";

export interface PollDeps {
  /** GET /api/payment/:id — also what triggers lazy server-side verification. */
  checkPaymentStatus: (id: string) => Promise<PaymentResult>;
  /** Resolves after `ms`. Injected so tests can run a simulated clock. */
  sleep: (ms: number) => Promise<void>;
  /** Still pending; `elapsedMs` is cumulative time inside the main window. */
  onPending: (elapsedMs: number) => void;
  /** Terminal success. Fires in the main window and the background phase. */
  onVerified: (payment: Payment) => void;
  /** Terminal failure. Only fires in the main window (see `onTimeout`). */
  onFailed: (errorMessage: string) => void;
  /** Main window exhausted — show the timeout error, polling continues. */
  onTimeout: () => void;
}

/**
 * Poll until the payment is verified or failed.
 *
 * Errors thrown by `checkPaymentStatus` propagate to the caller (unchanged
 * from the previous inline implementation — the caller's try/catch renders
 * them).
 */
export async function pollPaymentVerified(id: string, deps: PollDeps): Promise<void> {
  const { checkPaymentStatus, sleep, onPending, onVerified, onFailed, onTimeout } = deps;

  /** Returns true when polling should stop (verified or failed). */
  async function checkOnce(showFailure: boolean): Promise<boolean> {
    const result = await checkPaymentStatus(id);
    const payment = result.payment;
    if (payment?.status === "verified") {
      onVerified(payment);
      return true;
    }
    if (payment?.status === "failed") {
      if (showFailure) {
        onFailed(result.error || DEFAULT_FAILED_MESSAGE);
      }
      return true;
    }
    return false;
  }

  let elapsedMs = 0;
  while (elapsedMs < MAIN_WINDOW_MS) {
    const intervalMs = elapsedMs < FAST_WINDOW_MS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
    await sleep(intervalMs);
    elapsedMs += intervalMs;
    if (await checkOnce(true)) return;
    onPending(elapsedMs);
  }

  // Main window exhausted — surface the error, but keep a slow background
  // poll so a late-mined tx still verifies and fires the callback.
  onTimeout();

  let backgroundMs = 0;
  while (backgroundMs < BACKGROUND_WINDOW_MS) {
    await sleep(BACKGROUND_INTERVAL_MS);
    backgroundMs += BACKGROUND_INTERVAL_MS;
    // Don't overwrite the visible timeout error on "failed"; only flip on success.
    if (await checkOnce(false)) return;
  }
}

/** `120000` -> `"2m 0s"`, `45000` -> `"45s"`. */
export function formatElapsed(elapsedMs: number): string {
  const elapsedSec = Math.round(elapsedMs / 1000);
  return elapsedSec >= 60
    ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
    : `${elapsedSec}s`;
}
