# Topup feature — handoff

**Branch:** `feat/topup-callback-field`
**Status:** Complete and committed (`c791022` — "feat(crypto): add topup support to callback payload (#29)").
**Verification:** root `tsc --noEmit` clean; `tests/e2e-topup.test.ts` + `tests/server.test.ts` = 48/48 pass.

## What the feature does

Adds a credit "top-up" purchase path alongside subscription plans. A payment is now **either** a plan **or** a top-up (mutually exclusive). The `topup` id flows end-to-end: `/api/payment` request body → `payment_intents.topup_id` column → callback payload `topup` field → SPA pricing/display.

Authoritative top-up packs (server-side source of truth in `src/server.ts`): `small=$5`, `medium=$10`, `large=$25`.

## Origin

A code review (recall mode) of the original branch flagged that the feature was **broken for production**: the code inserted a `topup_id` column that no migration ever created, so every `/api/payment` insert would fail in prod. That plus 11 other findings were fixed. This doc covers the fixed state.

## Fixes applied (by finding)

| # | Problem | Fix | File |
|---|---------|-----|------|
| 1 | `topup_id` inserted but column never added → all payment inserts fail in prod | New migration `ADD COLUMN IF NOT EXISTS topup_id text` + synced reference schema | `supabase/migrations/20260626120000_add_topup_id.sql`, `supabase/schema.sql` |
| 2 | `insertPayment` outside try/catch → bare 500 | Wrapped → structured `{error}` 500 | `src/server.ts` |
| 3 | `resolveplan` ran for top-ups → spurious `plan_id` + callback emits both `plan` & `topup` | Gated: `const planId = body.topup ? null : resolveplan(...)` | `src/server.ts` |
| 4 | No amount check → pay $0.01 for `topup=large` | `amountUsd < TOPUP_PRICES[topup]` → 400 underpaid | `src/server.ts` |
| 5 | No whitelist → arbitrary `topup` stored | `body.topup in TOPUP_PRICES` else 400 | `src/server.ts` |
| 6 | tx_hash UPDATE unchecked → dedup hole → double payment | UPDATE now throws on error | `src/db.ts` |
| 7 | Client-side pack table is sole price authority | Server now validates amount (#4); web table kept for display only | `src/server.ts` |
| 8 | Unknown `?topup=` → silent $5 charge + raw label | Error state, pay disabled, no raw render | `web/src/app/pay/page.tsx` |
| 10 | `PaymentResult` lacked `topup_id`; success msg showed plan label | Added `topup_id?: string \| null`; success shows pack label | `web/src/lib/config.ts`, `web/src/app/pay/page.tsx` |
| 11 | Wallet JSON (private key + mnemonic) not gitignored; key printed to stdout | `.gitignore` blocks `testnet/*.json|png|key`; removed key/mnemonic `console.log` | `.gitignore`, `testnet/testwallet.ts` |
| 12 | `fetch` mock not restored on assertion failure → test pollution | `afterEach` restores `globalThis.fetch` | `tests/e2e-topup.test.ts`, `tests/server.test.ts` |
| 13 | Tests asserted only `topup_id`, masking dual-field bug | Added `plan_id===null` asserts + new `topup=large` collision test | `tests/e2e-topup.test.ts` |
| 14 | `/v1/payment_intents` didn't parse `topup_id` | Added `topup_id` to body schema + passthrough | `src/server.ts` |

## Contract (for callback consumers / the bot)

- Top-up payment: callback has `topup` = pack id, `plan` **absent**. DB row: `topup_id` set, `plan_id` null.
- Plan payment: callback has `plan` = plan id, `topup` **absent**.
- Note: callback uses `?? undefined`, so `JSON.stringify` **omits** the unused key entirely (it is not `null`). Consumers must check key presence/truthiness, not `=== null`.

## Deferred — not done (deliberate)

- **#9 callback `plan: ?? undefined`** — left as-is. The HMAC-break concern was **refuted** (signature is computed over the exact bytes sent, so consumers verifying received bytes are unaffected). The key-omission behavior change is consumer-dependent; needs the bot's contract to decide if it matters.
- **#15 Telegram `start_param` top-up deep-link** — not implemented. `start_param` only parses `plan_uid`; top-ups must be passed via the `?topup=` query param. Implementing a deep-link format is a cross-system contract with the bot — don't guess it. A code comment notes this in `pay/page.tsx`.
- **Web verification** — ✅ DONE. Ran `pnpm i && pnpm test` in `web/`: 81/81 tests pass, `tsc` clean on production code (`page.tsx` included), no test changes needed. (Pre-existing unrelated tsc noise: `ton.test.ts` BigInt/ES2017 target + `setup.ts` `vi` types — not topup.)
- **Existing `testnet/wallet-1.json` / `.png`** — now gitignored, but still on disk holding a real testnet private key + seed. Rotate/delete if that key was ever exposed.

## Context notes

- This repo's working tree is **shared by multiple concurrent agent sessions** (cmux). During this work, a separate session independently added an Arbitrum + `agentUSD` (`ausd`) token, committed as `153186a`. Its edits to `src/config.ts`, `src/verify.ts`, `src/server.ts` are in non-overlapping sections — no conflict with the topup work. If you see `ausd` in those files, it is **not** part of the topup feature.
- Test suite gotcha: running the full `vitest run` surfaces 3 unrelated failures from `.opencode/node_modules/zod/**` (vendored test files with missing deps leaking into the glob). They are not topup-related. Run scoped: `npx vitest run tests/e2e-topup.test.ts tests/server.test.ts`.

## How to verify

```bash
# from repo root
npx tsc --noEmit
npx vitest run tests/e2e-topup.test.ts tests/server.test.ts   # expect 48 pass
grep -n "topup_id" supabase/migrations/*.sql supabase/schema.sql
# web (needs deps installed)
cd web && pnpm i && pnpm test
```
