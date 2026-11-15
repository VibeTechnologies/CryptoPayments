# Plan — Task 35: Mobile Wallet QR Connect

## Approach Summary
Add Reown AppKit to CryptoPayments web. New `appkit.ts` singleton, new `connectEvmMobile()`, new button in `WalletConnect` component. Existing extension path untouched. All tests updated.

## Tradeoff: Speed vs Quality
- chosen: **balanced**
- rationale: payment page — correctness critical; but scoped change (~5 files), not complex arch.

## Tasks

| # | Title | Files | Depends | Group | Model |
|---|-------|-------|---------|-------|-------|
| 1 | Install AppKit packages + add env var to .env.example | `web/package.json`, `web/.env.example` | — | A | haiku |
| 2 | Create `appkit.ts` singleton + `getAppKitSigner()` | `web/src/lib/wallets/appkit.ts` | — | A | sonnet |
| 3 | Add `connectEvmMobile()` to `evm.ts` | `web/src/lib/wallets/evm.ts` | 2 | B | sonnet |
| 4 | Update `providers.tsx` — import appkit init side-effect | `web/src/app/providers.tsx` | 2 | B | haiku |
| 5 | Update `WalletConnect` component — add mobile connect button + mode | `web/src/components/wallet-connect.tsx` | 3 | C | sonnet |
| 6 | Update/add unit tests | `web/src/__tests__/components/wallet-connect.test.tsx`, `web/src/__tests__/lib/evm.test.ts` | 5 | D | sonnet |

## Parallel Groups
- **A** (no deps): 1, 2 — spawn together
- **B**: 3, 4 — after A
- **C**: 5 — after B
- **D**: 6 — after C

## Done Criteria
1. `pnpm install` succeeds in `web/`
2. `appkit.ts` exports `appKit` singleton + `getAppKitSigner()`; requires `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`
3. `evm.ts` exports `connectEvmMobile(chainId)` — calls `appKit.open()`, returns `{signer, address}`
4. `providers.tsx` imports `appkit.ts` so singleton initializes on app load
5. `WalletConnect` renders "Connect Mobile Wallet" button for EVM chains; extension button still shown when `window.ethereum` present
6. `pnpm test` (vitest) passes with no regressions

## Rollback Plan
`git revert` the commits. Remove `@reown/appkit*` from `package.json`. AppKit is fully additive — no existing code path removed.
