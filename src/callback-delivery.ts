/**
 * Durable, idempotent redelivery of the verified-payment webhook.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before this, `recordCallbackOutcome` only LOGGED the result of the single
 * delivery attempt. If the consumer returned 5xx, timed out, or was briefly
 * down, the payment was verified on-chain, the money was received, and the
 * consumer never credited the user. Nothing ever tried again. That is a
 * permanent, silent loss of a real customer's money — the largest hole in the
 * crypto rail, and it affects OpenClawBot in production today.
 *
 * RUNTIME CONSTRAINT (this is what dictates the design)
 * -----------------------------------------------------
 * The service runs as a **Supabase Edge Function** (`supabase/config.toml`
 * `[functions.crypto-payments]`, entry `Deno.serve` in
 * `supabase/functions/crypto-payments/index.ts`). It is request-scoped: the
 * isolate is created for a request and torn down shortly after the response.
 * There is NO long-lived process, so `setTimeout`/`setInterval` retry loops do
 * not survive — a scheduled retry 60s later simply never runs. Any retry
 * mechanism must therefore be (1) driven by state in the DB, and (2) triggered
 * by an inbound HTTP request.
 *
 * This module is deliberately PURE + injectable (clock, fetch, signer) so the
 * whole retry policy is unit-testable without a network, a DB, or wall-clock
 * sleeps.
 */

// ── Retry policy ─────────────────────────────────────────────────────────────

export interface RetryPolicy {
  /** Delay before attempt N+1, before jitter. */
  baseDelayMs: number;
  /** Multiplier applied per attempt. */
  factor: number;
  /** Upper bound on a single delay. */
  maxDelayMs: number;
  /** After this many attempts a retryable failure becomes terminal. */
  maxAttempts: number;
}

/**
 * 30s, 1m, 2m, 4m, 8m, 16m, 30m, 30m ... capped at 30m, giving up after 8
 * attempts (~1h20m of coverage). Long enough to ride out a consumer deploy or
 * a short outage; short enough that a genuinely broken consumer surfaces as
 * `needs_attention` within the hour instead of retrying forever.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 30_000,
  factor: 2,
  maxDelayMs: 30 * 60_000,
  maxAttempts: 8,
};

/** Delay to wait AFTER `attempts` failed attempts. `attempts` is 1-based. */
export function backoffMs(attempts: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  const n = Math.max(1, attempts);
  const raw = policy.baseDelayMs * Math.pow(policy.factor, n - 1);
  return Math.min(raw, policy.maxDelayMs);
}

// ── Delivery state ───────────────────────────────────────────────────────────

/**
 * `pending`        — at least one attempt failed retryably; more are due.
 * `delivered`      — TERMINAL success. Never re-sent.
 * `needs_attention`— TERMINAL failure. An operator must resolve it by hand;
 *                    the money is in and the customer has nothing.
 */
export type CallbackDeliveryStatus = "pending" | "delivered" | "needs_attention";

export interface CallbackDeliveryState {
  url: string | null;
  status: CallbackDeliveryStatus;
  attempts: number;
  /** ISO timestamp of the most recent attempt. */
  last_attempt_at: string | null;
  /** ISO timestamp at which the next attempt becomes due (null when terminal). */
  next_attempt_at: string | null;
  /** ISO timestamp of the successful delivery (null unless `delivered`). */
  delivered_at: string | null;
  /** HTTP status of the last attempt, when there was a response at all. */
  last_status: number | null;
  last_error: string | null;
  /**
   * Machine-greppable reason a delivery went terminal without succeeding.
   * Paired with the txHash in the alert log line so an operator can find the
   * stuck money.
   */
  terminal_reason: string | null;
}

/** The result of ONE delivery attempt. */
export type AttemptOutcome =
  | { ok: true }
  | {
      ok: false;
      /** HTTP status, when the consumer actually answered. */
      status?: number;
      /** Human-readable failure. */
      error: string;
      /**
       * Set when the failure is structurally unfixable by retrying the same
       * bytes (e.g. the host is not allowlisted, the URL is not HTTPS).
       */
      permanent?: boolean;
    };

/**
 * Is this failure worth retrying?
 *
 * 5xx / timeout / network error  -> retryable. The consumer is down or broken;
 *                                   the same bytes may well succeed later.
 * 408 Request Timeout, 429 Too Many Requests -> retryable by definition.
 * any other 4xx                  -> NOT retryable. The consumer looked at the
 *                                   payload and rejected it (bad plan, unknown
 *                                   product, failed signature check). Resending
 *                                   identical bytes can only be rejected again,
 *                                   so it goes terminal `needs_attention`
 *                                   immediately and LOUDLY — not silently.
 */
export function isRetryable(outcome: AttemptOutcome): boolean {
  if (outcome.ok) return false;
  if (outcome.permanent) return false;
  const s = outcome.status;
  if (s === undefined) return true; // network error / timeout — no response
  if (s === 408 || s === 429) return true;
  if (s >= 400 && s < 500) return false;
  return true; // 5xx and anything else unexpected
}

/**
 * Fold one attempt's outcome into the persisted state.
 *
 * Pure: takes the clock as a number so tests assert backoff ORDERING and
 * SCHEDULING arithmetic instead of sleeping.
 */
export function computeNextState(
  prior: Partial<CallbackDeliveryState> | null | undefined,
  url: string | null,
  outcome: AttemptOutcome,
  nowMs: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): CallbackDeliveryState {
  const attempts = (typeof prior?.attempts === "number" ? prior.attempts : 0) + 1;
  const nowIso = new Date(nowMs).toISOString();

  if (outcome.ok) {
    return {
      url,
      status: "delivered",
      attempts,
      last_attempt_at: nowIso,
      next_attempt_at: null,
      delivered_at: nowIso,
      last_status: 200,
      last_error: null,
      terminal_reason: null,
    };
  }

  const retryable = isRetryable(outcome);
  const exhausted = attempts >= policy.maxAttempts;

  if (!retryable || exhausted) {
    return {
      url,
      status: "needs_attention",
      attempts,
      last_attempt_at: nowIso,
      next_attempt_at: null,
      delivered_at: null,
      last_status: outcome.status ?? null,
      last_error: outcome.error,
      terminal_reason: outcome.permanent
        ? "not_deliverable"
        : !retryable
          ? `non_retryable_${outcome.status ?? "unknown"}`
          : "retries_exhausted",
    };
  }

  return {
    url,
    status: "pending",
    attempts,
    last_attempt_at: nowIso,
    next_attempt_at: new Date(nowMs + backoffMs(attempts, policy)).toISOString(),
    delivered_at: null,
    last_status: outcome.status ?? null,
    last_error: outcome.error,
    terminal_reason: null,
  };
}

/**
 * Should this state be attempted right now?
 *
 * Terminal states (`delivered`, `needs_attention`) are NEVER due — that is what
 * makes redelivery after success a no-op, and what stops a rejected payload
 * from being hammered forever.
 */
export function isDue(
  state: Partial<CallbackDeliveryState> | null | undefined,
  nowMs: number,
): boolean {
  if (!state) return false;
  if (state.status !== "pending") return false;
  if (!state.url) return false;
  if (!state.next_attempt_at) return true;
  const due = Date.parse(state.next_attempt_at);
  return Number.isNaN(due) ? true : due <= nowMs;
}

// ── Payload construction + signing ───────────────────────────────────────────

/** Everything about the callback body EXCEPT the timestamp. */
export interface CallbackPayloadBody {
  event: "payment.verified";
  payment: Record<string, unknown>;
}

/**
 * FRESHNESS vs IDEMPOTENCY — the one genuinely subtle decision here.
 *
 * The consumer (platform `subscriptions/lib/crypto-callback.cjs`, PR #77, and
 * OpenClawBot's `crypto-webhook.ts`) validates freshness from the **SIGNED**
 * `payload.timestamp` in the body, with a ±300s window. The `x-timestamp`
 * header is not covered by the HMAC and is only a pre-filter, so it cannot be
 * used to refresh a stale body.
 *
 * Consequence: a redelivery of the ORIGINAL bytes 10 minutes later is rejected
 * as a replay. Byte-identical redelivery is therefore *impossible* against this
 * consumer contract.
 *
 * DECISION: re-sign with a FRESH `timestamp` on every attempt; every other byte
 * of the payload — critically `payment.txHash` — is identical across attempts.
 *
 * Exactly-once is preserved by the CONSUMER's txHash dedupe, not by the
 * producer's bytes: the consumer normalises the hash (`normalizeTxHash`, lower
 * + trim) and enforces a uniqueness constraint on it, so a second successful
 * delivery of the same txHash credits nothing. That dedupe is the invariant we
 * depend on; `assertRedeliverySafe` below encodes it as an executable check so
 * a future change to either rule breaks a test rather than customers.
 */
export function buildSignedPayload(
  body: CallbackPayloadBody,
  nowMs: number,
): { payload: string; timestamp: string } {
  const timestamp = Math.floor(nowMs / 1000).toString();
  return {
    payload: JSON.stringify({ ...body, timestamp }),
    timestamp,
  };
}

/** The consumer's replay window, mirrored here so we can assert against it. */
export const CONSUMER_TIMESTAMP_WINDOW_SEC = 300;

/**
 * Executable statement of the consumer's freshness rule.
 *
 * Returns true iff a payload signed at `signedAtMs` is still accepted by a
 * consumer evaluating it at `receivedAtMs`.
 */
export function passesConsumerFreshness(
  payloadTimestamp: string,
  receivedAtMs: number,
  windowSec: number = CONSUMER_TIMESTAMP_WINDOW_SEC,
): boolean {
  const ts = Number(payloadTimestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(Math.floor(receivedAtMs / 1000) - ts) <= windowSec;
}

/**
 * The two-part invariant every redelivery must satisfy:
 *   1. it is FRESH enough for the consumer to accept, and
 *   2. its txHash is UNCHANGED, so the consumer's dedupe still collapses it.
 */
export function assertRedeliverySafe(
  firstPayload: string,
  redeliveredPayload: string,
  redeliveredAtMs: number,
): { fresh: boolean; sameTxHash: boolean } {
  const a = JSON.parse(firstPayload);
  const b = JSON.parse(redeliveredPayload);
  return {
    fresh: passesConsumerFreshness(b.timestamp, redeliveredAtMs),
    sameTxHash: a.payment?.txHash === b.payment?.txHash,
  };
}
