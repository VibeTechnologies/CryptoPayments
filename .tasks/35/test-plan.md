# Test Plan — Task 35: Mobile Wallet QR Connect

## The Hard Part

QR scanning requires a real mobile device. `window.ethereum` mock pattern
(used in `e2e-pay-webapp.spec.ts`) doesn't work for AppKit/WalletConnect —
the session runs over a WebSocket relay, not injected globals.

**Validation strategy: 4 tiers.**

---

## Tier 1 — Unit Tests (automated, CI, no device needed)

**Runner:** `vitest` in `web/`  
**What:** component + lib behavior under mocked AppKit

### New test file: `web/src/__tests__/lib/appkit.test.ts`

Test that `appkit.ts` module exports are correct shapes:
- `appKit` is defined after import
- `getAppKitSigner()` calls `appKit.getProvider('eip155')` and wraps in `BrowserProvider`
- throws `"No WalletConnect session"` when `getProvider` returns null

### New tests in `web/src/__tests__/lib/evm.test.ts`

```typescript
// Mock appkit module
vi.mock('@/lib/wallets/appkit', () => ({
  appKit: {
    open: vi.fn(),
    getIsConnected: vi.fn(() => true),
  },
  getAppKitSigner: vi.fn(() => Promise.resolve({
    getAddress: () => Promise.resolve('0xMobileAddr'),
    provider: { send: vi.fn() },
  })),
}))

it('connectEvmMobile calls appKit.open()', ...)
it('connectEvmMobile returns signer + address after open', ...)
it('throws "Wallet connection cancelled" when getIsConnected() false', ...)
it('calls wallet_switchEthereumChain via provider.send after connect', ...)
```

### New tests in `web/src/__tests__/components/wallet-connect.test.tsx`

```typescript
vi.mock('@/lib/wallets/appkit', ...) // same mock as above
vi.mock('@/lib/wallets/evm', () => ({
  ...existing,
  connectEvmMobile: vi.fn(),
}))

it('renders "Connect Mobile Wallet" button for EVM chains (base)')
it('renders "Connect Mobile Wallet" button for EVM chains (eth)')
it('does NOT render "Connect Mobile Wallet" for sol or ton')
it('clicking "Connect Mobile Wallet" calls connectEvmMobile(chain)')
it('"Connect Wallet" (extension) still present when window.ethereum exists')
it('after mobile connect, shows connected address + Pay button')
it('Pay button calls sendEvmTransfer with mobile signer')
```

**Pass criterion:** `pnpm test` in `web/` exits 0, no regressions in existing 15 tests.

---

## Tier 2 — Build Verification (automated, CI)

**Runner:** `pnpm build` in `web/`  
**What:** TypeScript compiler + Next.js static export

AppKit has complex generics. If the ethers adapter isn't wired correctly,
or if `createAppKit` call shape is wrong, this fails at compile time.

```bash
cd web && pnpm build
# Must exit 0, no TypeScript errors, generates /out/ static export
```

**Pass criterion:** exit 0, `out/` directory populated.

---

## Tier 3 — Playwright Modal Smoke (automated, needs Reown Project ID)

**Runner:** `playwright` at repo root  
**What:** real browser → real AppKit init → modal renders → wallet list visible  
**Requires:** `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` env var (free Reown account)

### New test: `tests/e2e-mobile-wallet-modal.spec.ts`

```typescript
test('AppKit modal opens on "Connect Mobile Wallet" click', async ({ page }) => {
  await page.goto('/pay?plan=starter&uid=123&idtype=tg&test=true')
  // Wait for config to load
  await page.waitForSelector('[data-testid="chain-base_sepolia"]')
  await page.click('[data-testid="chain-base_sepolia"]')
  await page.click('button:has-text("Connect Mobile Wallet")')

  // AppKit renders as web components — modal should appear
  const modal = page.locator('wui-modal, appkit-modal').first()
  await expect(modal).toBeVisible({ timeout: 8000 })

  // WalletConnect QR code must be present
  const qr = page.locator('wui-qr-code, canvas[data-qr], svg[data-qr]').first()
  await expect(qr).toBeVisible({ timeout: 5000 })

  // Coinbase Wallet and Rabby must appear in featured list
  await expect(page.locator('text=/Coinbase Wallet/i').first()).toBeVisible()
  await expect(page.locator('text=/Rabby/i').first()).toBeVisible()
})

test('extension "Connect Wallet" still visible alongside mobile button', async ({ page }) => {
  await page.goto('/pay?plan=starter&uid=123&idtype=tg')
  // Inject window.ethereum mock (simulates extension present)
  await page.addInitScript(() => {
    (window as any).ethereum = { request: () => Promise.reject('test') }
  })
  await page.reload()
  await expect(page.locator('button:has-text("Connect Wallet")')).toBeVisible()
  await expect(page.locator('button:has-text("Connect Mobile Wallet")')).toBeVisible()
})
```

**What this proves:**
- AppKit initializes (real Reown relay connection)
- Modal renders correct web components
- QR code is visible and rendered
- Featured wallets appear (Coinbase + Rabby)
- Regression: extension path still present

**What this does NOT prove:**
- QR is scannable by a real wallet (encoding/protocol correctness)
- Session handshake completes
- Transaction signing works

**Pass criterion:** both tests pass in headed or headless Chromium.

---

## Tier 4 — Manual Real Device E2E (required for R1)

**Environment:** Vercel preview deploy + Base Sepolia + real mobile devices  
**When:** after Tier 1–3 pass  
**Who:** engineer with iPhone/Android + Coinbase Wallet + Rabby mobile

### Setup

1. Deploy PR branch to Vercel preview (auto-triggered by CI)
2. Get Base Sepolia test USDC from faucet: https://faucet.circle.com (Base Sepolia)
3. Note preview URL: `https://cryptopayments-pay-git-own-35-<slug>-vibetechnologies.vercel.app`

### Protocol

```
DEVICE A: Coinbase Wallet mobile (iPhone or Android)
DEVICE B: Rabby Wallet mobile (iPhone or Android)
URL: <vercel-preview>/pay?plan=starter&uid=123456&idtype=tg&test=true
```

**Test A — Coinbase Wallet**
1. Open URL on desktop browser
2. Select "Base Sepolia" chain, "USDC" token
3. Click "Connect Mobile Wallet"
4. AppKit modal appears with QR + Coinbase Wallet card
5. On phone: open Coinbase Wallet → tap "Connect" → scan QR
6. Desktop shows: "Connected: 0x…" (Coinbase Wallet address)
7. Click "Pay $[amount] USDC"
8. Phone: Coinbase Wallet shows transaction approval prompt
9. Approve on phone
10. Desktop shows: "Payment verified" ✅

**Test B — Rabby Wallet**
1–4. Same as Test A
5. On phone: open Rabby → Settings → WalletConnect → scan QR
6–10. Same flow

**Test C — Extension regression (must not break)**
1. Open URL with MetaMask/Rabby extension installed
2. Click "Connect Wallet" (extension button)
3. Extension popup → approve → connected
4. Pay → extension prompts → approve
5. "Payment verified" ✅

### Evidence required

Screenshot or screen recording showing:
- QR modal opened
- "Connected: 0x…" state after mobile scan
- "Payment verified" final state
- Both Coinbase Wallet and Rabby mobile successfully connected

---

## CI Integration

```yaml
# Add to .github/workflows:
- name: Unit tests
  run: cd web && pnpm test

- name: Build
  run: cd web && pnpm build
  env:
    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: ${{ secrets.REOWN_PROJECT_ID }}

- name: Playwright modal smoke
  run: npx playwright test tests/e2e-mobile-wallet-modal.spec.ts
  env:
    BASE_URL: ${{ steps.vercel-preview.outputs.url }}
    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: ${{ secrets.REOWN_PROJECT_ID }}
```

Secret needed: `REOWN_PROJECT_ID` (free — register at dashboard.reown.com, store in Bitwarden).

---

## Summary

| Tier | Automated? | Device needed? | Proves |
|------|-----------|----------------|--------|
| 1 Unit | ✅ CI | ❌ | Logic correctness, no regression |
| 2 Build | ✅ CI | ❌ | TypeScript + AppKit integration compiles |
| 3 Playwright | ✅ CI (needs Project ID) | ❌ | Modal renders, QR visible, wallets listed |
| 4 Manual E2E | ❌ manual | ✅ real phone | QR scans, session works, payment completes |

**Tiers 1–3 gate the PR merge.** Tier 4 is the R1 success metric.
