# Design — Task 35: Mobile Wallet QR Connect

## Problem
EVM connect uses `window.ethereum` only. Blocks Coinbase Wallet mobile and Rabby mobile users.

## Goal
QR code modal on payment page for EVM chains. Mobile wallet scans → session → signs payment.

## Success Metric (R1)
Task is done when opening `https://pay.oclawbox.com/pay?plan=starter&uid=123&idtype=tg`, selecting Base, clicking "Connect Mobile Wallet", scanning QR with Coinbase Wallet mobile or Rabby mobile, and clicking Pay results in a transaction confirmation on mobile and payment verified on web page.

## Out of Scope
- Solana/TON QR (already have TonConnect; Phantom has its own deeplink)
- SIWE authentication
- Coinbase Smart Wallet (passkey/EIP-5792) — different product

## Current State

### Files
- `web/src/components/wallet-connect.tsx` — EVM: `window.ethereum` → `connectEvm()` → Signer
- `web/src/lib/wallets/evm.ts` — `connectEvm()`, `sendEvmTransfer()`
- `web/src/app/providers.tsx` — TonConnect provider; no WalletConnect
- `web/src/lib/config.ts` — chain config, EVM_CHAINS, EVM_CHAIN_IDS
- `web/package.json` — ethers@6, @tonconnect/ui-react; no AppKit

### Gap
No WalletConnect/AppKit dep. No mobile QR path.

## Proposed Design

Add Reown AppKit as the WalletConnect v2 implementation:

```
window.ethereum present? → extension connect (unchanged)
                          ↓
"Connect Mobile Wallet" button
  → appKit.open()
  → modal: WalletConnect QR (Rabby scans) + Coinbase Wallet card (WalletLink QR)
  → session established
  → appKit.getProvider('eip155') → new BrowserProvider(provider)
  → getSigner() → sendEvmTransfer() [UNCHANGED]
```

### New files
- `web/src/lib/wallets/appkit.ts` — singleton AppKit init + `getAppKitSigner()`

### Modified files
- `web/src/lib/wallets/evm.ts` — add `connectEvmMobile()`
- `web/src/components/wallet-connect.tsx` — add "Connect Mobile Wallet" button + mode state
- `web/src/app/providers.tsx` — import appkit.ts (side-effect init)
- `web/.env.example` — add `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`
- `web/package.json` — add `@reown/appkit@1.8.21`, `@reown/appkit-adapter-ethers@1.8.21`

### Key config
```typescript
featuredWalletIds: [
  '18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1', // Rabby (must be explicit)
  'fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa', // Coinbase Wallet
]
coinbasePreference: 'all' // Smart Wallet popup + WalletLink mobile QR
```

### Env var needed
`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` — free Reown project ID from dashboard.reown.com.
Store in Bitwarden, add to Azure SWA + Vercel settings.

## Alternatives Considered

1. **`@coinbase/wallet-sdk` only** — covers Coinbase Wallet only; misses Rabby and all other WC2 wallets. Rejected.
2. **Raw `@walletconnect/sign-client`** — low-level, no UI, large bundle. Rejected; AppKit bundles it + adds modal + connectors.
3. **WalletConnect v1 (legacy)** — deprecated. Rejected.

## Risks & Open Questions

| Risk | Mitigation |
|------|------------|
| Bundle size +135 KB gzipped | AppKit is lazy-loaded; only loaded when EVM QR modal opens |
| Reown Project ID required free registration | Store in Bitwarden; needed once per environment |
| AppKit SSR hydration mismatch in Next.js | Import in `providers.tsx` (`'use client'`); not in server components |
| Rabby WalletConnect Explorer ID changes | Verified from official WC Explorer API today (2026-06-29): `18388be9...` |
| `window.ethereum` still checked for Rabby extension on desktop | Unchanged; EIP-6963 auto-detects Rabby ext via AppKit too |
