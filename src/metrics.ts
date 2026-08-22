/**
 * Minimal in-process counters for RPC retry/backoff observability
 * (AGE-1069 / AGE-970 decision item 4).
 *
 * Founder ruling on AGE-970: "just add retry logic with exponential
 * backoff ... emit a counter for retries and exhaustions. If exhaustion is
 * ever non-zero in steady state, come back with that number." This module
 * is that counter — no new metrics infra, just an in-process tally exposed
 * via a log line and GET /api/admin/metrics.
 *
 * Intentionally process-local (resets on restart/deploy). That is fine for
 * "is exhaustion ever non-zero in steady state" — a restart-reset counter
 * still surfaces the signal within any given process lifetime, and this
 * runs as a single long-lived Node/Deno process per environment, not a
 * fleet of ephemeral workers.
 */

export interface CounterSnapshot {
  rpcRetryAttempts: Record<string, number>;
  rpcRetryAttemptsTotal: number;
  rpcExhaustions: Record<string, number>;
  rpcExhaustionsTotal: number;
}

const rpcRetryAttempts = new Map<string, number>();
const rpcExhaustions = new Map<string, number>();

function bump(map: Map<string, number>, chainId: string): number {
  const next = (map.get(chainId) ?? 0) + 1;
  map.set(chainId, next);
  return next;
}

function sum(map: Map<string, number>): number {
  let total = 0;
  for (const v of map.values()) total += v;
  return total;
}

/**
 * Record one retry attempt (a transient error caught inside
 * `withRpcFailover`, whether or not it is followed by another attempt,
 * a failover, or a sweep) for `chainId`. Logs a single-line, greppable
 * counter observation alongside the existing `[RPC-RETRY]` log line.
 */
export function recordRpcRetryAttempt(chainId: string): void {
  const count = bump(rpcRetryAttempts, chainId);
  console.log(`[METRIC] rpc_retry_attempts_total chain=${chainId} count=${count}`);
}

/**
 * Record one full sweep-budget exhaustion (a `TransientVerificationError`
 * was thrown) for `chainId`.
 */
export function recordRpcExhaustion(chainId: string): void {
  const count = bump(rpcExhaustions, chainId);
  console.log(`[METRIC] rpc_exhaustions_total chain=${chainId} count=${count}`);
}

/** Read-only snapshot for GET /api/admin/metrics and tests. */
export function getCounterSnapshot(): CounterSnapshot {
  return {
    rpcRetryAttempts: Object.fromEntries(rpcRetryAttempts),
    rpcRetryAttemptsTotal: sum(rpcRetryAttempts),
    rpcExhaustions: Object.fromEntries(rpcExhaustions),
    rpcExhaustionsTotal: sum(rpcExhaustions),
  };
}

/** Test-only: reset counters between test cases. */
export function __resetCountersForTest(): void {
  rpcRetryAttempts.clear();
  rpcExhaustions.clear();
}
