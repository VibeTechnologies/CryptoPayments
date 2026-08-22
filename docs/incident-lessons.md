# Incident lessons — repo-wide invariants earned the hard way

This file collects the durable rules a real incident forced us to learn.
They apply beyond the code path that triggered them. Add to this file, don't
bury the lesson in a closed ticket.

## Never collapse "it did not happen" into "I could not find out"

**Origin:** [AGE-957](/AGE/issues/AGE-957) / [AGE-960](/AGE/issues/AGE-960) — a
real on-chain aUSD transfer was mined while `withRpcFailover` timed out on all
three free public RPC endpoints in the same window. The verifier's result type
only had two states, `verified` and `failed`; there was no way to represent
"the chain node didn't answer in time." The catch path called
`markPaymentFailed()`, writing a **terminal** `failed` row with `amount = 0`
while the customer's money sat confirmed on-chain. Recovery required a manual
reset — both the lazy re-verify path and the reconcile cron only ever look at
**non-terminal** rows, so a payment that lands in `failed` cannot self-heal.
Fixed in [PR #50](https://github.com/VibeTechnologies/CryptoPayments/pull/50)
by adding a third `"pending"` outcome to `VerifyResult`.

**The rule:**

> Any operation that reports on an external system it does not control must
> distinguish *"it did not happen"* from *"I could not find out."* Model that
> third state explicitly in the return type before writing any code against
> it — if the type only has two cases, the code and its tests will too, and
> the missing case is exactly the one a distributed system hits in
> production. Never let a code path reachable by a timeout, a retry
> exhaustion, or a network error write a terminal state on behalf of the
> business. A terminal state is a claim about reality with no way back; only
> a completed, deterministic answer earns the right to write one.

**How to apply it when writing a verifier, reconciler, or any check against
an external system (chain RPC, payment processor, third-party API):**

1. Define the result type with the indeterminate case first, not last object as an
   afterthought — `Verified | Rejected | Unknown`, never just
   `Verified | Rejected`.
2. Write the test for the indeterminate case before the happy path. If you
   can't write it because the type doesn't allow it, that's the signal the
   design is wrong, not that the test is optional.
3. Terminal-state writes (`failed`, `canceled`, `void`, ...) are only reachable
   from a code path that received a positive, completed answer that the
   business event did not occur. A timeout, an RPC error, a 5xx from a
   dependency, or an exhausted retry budget must return "unknown" and leave
   the record exactly as found.
4. Add a standing invariant check (integrity cron, not just a unit test) that
   verifies terminal `failed`/`canceled` rows have no corresponding
   confirmed external-system event. A model can be correct in isolation and
   still be violated by a bug elsewhere; only checking the invariant against
   live data catches that.
5. A failing invariant check must reach a human. A red job nobody is told
   about is the same failure as the missing state — see
   [AGE-964](/AGE/issues/AGE-964), where the CryptoPayments E2E had been red
   on `main` for 2+ weeks with no alert, in the same subsystem that lost this
   money.
