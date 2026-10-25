# Technical Design Document — CryptoPayments

## Overview

This document covers the technical architecture of CryptoPayments and the implementation design for the **Mobile Wallet QR Connect** feature.

---

## System Architecture

```
User (browser)  ──>  Next.js SPA (Azure Static Web Apps / Vercel)
                          │
                     ┌────┴─────────────────────────────────┐
                     │  Wallet SDKs                          │
                     │  ├── ethers v6 (EVM extension)        │
                     │  ├── @reown/appkit (EVM mobile QR)   │ ← NEW
                     │  ├── @phantom/solana                  │
                     │  └── @tonconnect/ui-react (QR+deep)   │
                     └──────────────────┬───────────────────┘
                                        │
                              Supabase Edge Function API
                               /api/config · /api/payment
                                        │
                                  On-chain verify
                                  + webhook → OpenClawBot
```

**Hosting:** Azure Static Web Apps (custom domain `pay.oclawbox.com`), static export.  
**API:** Supabase Edge Functions — no changes required for this feature.

---

## Current EVM Connect Flow

```
window.ethereum present?
  YES → BrowserProvider(window.ethereum) → eth_requestAccounts
      → wallet_switchEthereumChain (or wallet_addEthereumChain)
      → getSigner() → sendEvmTransfer()
  NO  → show "Install MetaMask" link
```

**Limitation:** requires a browser extension. Blocks mobile wallet users (Coinbase Wallet mobile, Rabby mobile) who don't have the extension installed.

---

## Feature Design: Mobile Wallet QR Connect

### Protocol Choice

**WalletConnect v2** via **Reown AppKit** (formerly WalletConnect Web3Modal v3).

Rationale:
- Both Coinbase Wallet mobile and Rabby mobile implement WalletConnect v2 — one integration covers both.
- AppKit is the maintained successor to Web3Modal v2/v3; widely adopted, actively maintained by Reown (WalletConnect team).
- Provides ethers v6 adapter, keeping the existing `sendEvmTransfer()` function unchanged.
- Has first-class Next.js 14+ app router support with `'use client'` compatibility.
- Free tier available; requires only a Reown Project ID.

**Coinbase Wallet SDK** (`@coinbase/wallet-sdk`) is an alternative but covers only Coinbase Wallet. AppKit includes a dedicated Coinbase Wallet connector alongside the generic WalletConnect QR, giving better coverage with one library.

---

### Packages to Add

```bash
pnpm add @reown/appkit@1.8.21 @reown/appkit-adapter-ethers@1.8.21
```

| Package | Purpose |
|---------|---------|
| `@reown/appkit` | Modal UI, WalletConnect relay, wallet registry, embedded `@walletconnect/universal-provider` |
| `@reown/appkit-adapter-ethers` | EIP-1193 provider bridge → ethers v6 `BrowserProvider`; bundles `@coinbase/wallet-sdk` as optional dep |

Do **not** separately install `@walletconnect/sign-client` or `@walletconnect/universal-provider` — they are embedded inside AppKit.

**Environment variable** (add to `web/.env.example` and Azure/Vercel config):

```
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=<your-reown-project-id>
```

Get a free project ID at [dashboard.reown.com](https://dashboard.reown.com).

---

### Architecture After Change

```
WalletConnect component
  ├── Mode A: Browser extension (unchanged)
  │     window.ethereum → connectEvm() → Signer
  │
  └── Mode B: Mobile QR (new)
        AppKit modal open → WalletConnect v2 QR
          ↳ User scans with Coinbase Wallet / Rabby / any WC2 wallet
          ↳ Session established → AppKit EIP-1193 provider
          → new BrowserProvider(walletConnectProvider) → Signer
          → sendEvmTransfer() ← unchanged
```

Both paths produce an ethers `Signer`, so `sendEvmTransfer()` is reused without changes.

---

### Implementation Plan

#### Step 1 — AppKit configuration file (`web/src/lib/wallets/appkit.ts`)

```typescript
import { createAppKit } from '@reown/appkit'
import { EthersAdapter } from '@reown/appkit-adapter-ethers'
import { mainnet, base, arbitrum, baseSepolia, sepolia } from '@reown/appkit/networks'

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID!

const ethersAdapter = new EthersAdapter()

export const appKit = createAppKit({
  adapters: [ethersAdapter],
  projectId,
  networks: [base, mainnet, arbitrum, baseSepolia, sepolia],
  defaultNetwork: base,
  metadata: {
    name: 'OpenClawBox Payments',
    description: 'Pay for OpenClawBox subscriptions with crypto',
    url: 'https://pay.oclawbox.com',
    icons: ['https://pay.oclawbox.com/icon.png'],
  },
  // Rabby must be explicitly featured (its WalletConnect Explorer listing is stale/miscategorized)
  // Coinbase Wallet has a first-class connector in AppKit; its ID here shows it prominently in the list
  featuredWalletIds: [
    '18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1', // Rabby Wallet (verified WC Explorer ID)
    'fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa', // Coinbase Wallet
  ],
  // 'all': show Smart Wallet popup AND WalletLink mobile QR for Coinbase Wallet
  // 'eoaOnly': WalletLink mobile QR only (no Smart Wallet)
  coinbasePreference: 'all',
  features: {
    analytics: false,
    email: false,
    socials: [],
  },
})

/** Get ethers Signer from AppKit's active session. Call after openModal resolves. */
export async function getAppKitSigner() {
  const provider = appKit.getProvider('eip155')
  if (!provider) throw new Error('No WalletConnect session')
  const { BrowserProvider } = await import('ethers')
  const ethersProvider = new BrowserProvider(provider as Parameters<typeof BrowserProvider>[0])
  return ethersProvider.getSigner()
}
```

#### Step 2 — New `connectEvmMobile()` in `web/src/lib/wallets/evm.ts`

```typescript
export async function connectEvmMobile(chainId: ChainId): Promise<{ signer: Signer; address: string }> {
  const { appKit, getAppKitSigner } = await import('./appkit')
  
  await appKit.open()  // opens modal with QR code; resolves when modal is dismissed (connected or cancelled)

  const isConnected = appKit.getIsConnected()
  if (!isConnected) throw new Error('Wallet connection cancelled')

  const signer = await getAppKitSigner()
  const address = await signer.getAddress()

  // Switch to requested chain via the connected session
  const targetChainId = EVM_CHAIN_IDS[chainId]
  if (targetChainId) {
    try {
      const provider = await signer.provider as BrowserProvider
      await (provider as unknown as { send: (method: string, params: unknown[]) => Promise<unknown> })
        .send('wallet_switchEthereumChain', [{ chainId: targetChainId }])
    } catch (err: unknown) {
      if (isChainNotAddedError(err)) {
        const chainParams = EVM_CHAIN_PARAMS[chainId]
        if (chainParams) {
          const provider = await signer.provider as BrowserProvider
          await (provider as unknown as { send: (method: string, params: unknown[]) => Promise<unknown> })
            .send('wallet_addEthereumChain', [chainParams])
        }
      }
    }
  }

  return { signer, address }
}
```

#### Step 3 — `WalletConnect` component changes (`web/src/components/wallet-connect.tsx`)

Add a connect mode toggle for EVM chains:

```typescript
// In WalletConnect component, for EVM chains:
const [connectMode, setConnectMode] = useState<'extension' | 'mobile'>('extension')

// Has extension:
const hasEvmWallet = isEvm && isEvmAvailable()  // window.ethereum present

// Connect button section for EVM:
{isEvm && !connectedAddress && (
  <>
    {/* Primary: extension connect (if available) */}
    {hasEvmWallet && (
      <button onClick={() => handleConnectEvm('extension')}>
        Connect Wallet
      </button>
    )}

    {/* Mobile QR connect */}
    <button onClick={() => handleConnectEvm('mobile')} className="...">
      {hasEvmWallet ? 'Connect Mobile Wallet' : 'Connect Wallet'}
      {/* On desktop with no extension: this becomes the primary button */}
    </button>
  </>
)}
```

`handleConnectEvm(mode)`:
- `'extension'` → existing `connectEvm(chain)` path
- `'mobile'` → `connectEvmMobile(chain)` → opens AppKit modal

#### Step 4 — `providers.tsx` — initialize AppKit once

```typescript
// web/src/app/providers.tsx  (already exists, wrap with AppKit init)
'use client'
import '@/lib/wallets/appkit' // side-effect: creates singleton appKit instance
```

AppKit must be initialized as a singleton before `appKit.open()` is called. Importing the module in `providers.tsx` ensures it initializes once on app load.

#### Step 5 — Environment variable

Add to `web/.env.example`:
```
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_reown_project_id_here
```

Add to Azure Static Web App app settings and Vercel project env vars.

---

### QR Code Modal Behavior

| Scenario | Behavior |
|----------|----------|
| Desktop (no extension) | AppKit modal shows QR code + Coinbase Wallet + Rabby in featured list |
| Desktop (with extension) | Extension connect is primary; "Connect Mobile Wallet" secondary option |
| Mobile browser (iOS/Android) | AppKit modal shows deep links; no QR (useless to scan own screen) |
| Telegram Mini App WebView | AppKit detects webview → shows deep links; WalletConnect session works the same |

AppKit automatically handles desktop vs. mobile rendering. No custom logic needed.

---

### Data Flow After Mobile Connect

```
1. appKit.open() → shows WalletConnect QR
2. User scans with Coinbase Wallet / Rabby mobile
3. WalletConnect v2 handshake (via Reown relay server)
4. appKit.getProvider('eip155') → EIP-1193 provider over WC2 session
5. new BrowserProvider(provider) → ethers v6 provider
6. provider.getSigner() → Signer
7. sendEvmTransfer(signer, tokenAddress, walletAddress, amount) 
   → contract.transfer() → prompts user on mobile wallet to approve
8. Returns tx.hash → submitPayment() → /api/payment → on-chain verify → webhook
```

No changes to steps 7–8. The API verification flow is chain-based (tx hash lookup), not wallet-type-specific.

---

### Rabby Wallet — Mobile Capabilities

| Capability | Desktop extension | Mobile app (iOS/Android) |
|------------|------------------|--------------------------|
| EVM transaction signing | ✅ | ✅ |
| WalletConnect v2 QR scanning | N/A | ✅ (uses `@reown/walletkit` internally) |
| Proprietary dApp login protocol | ❌ (none) | ❌ (none) |
| Deep link (`rabby://walletconnect`) | ❌ | ✅ |
| Auto-featured in AppKit modal | ✅ (EIP-6963, RDNS `io.rabby`) | ⚠️ No — must add to `featuredWalletIds` |

**WalletConnect Explorer ID** (verified): `18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1`

**Conclusion:** Rabby mobile uses WalletConnect v2 exclusively for dApp connection. No Rabby-specific SDK needed. However, Rabby's WalletConnect Explorer listing is categorized as "Injected Wallets" (stale metadata) so it does **not** appear automatically in AppKit's featured list — must be explicitly added via `featuredWalletIds`.

---

### Coinbase Wallet — Mobile Capabilities

| Capability | Desktop extension | Mobile app (iOS/Android) |
|------------|------------------|--------------------------|
| EVM transaction signing | ✅ via `window.ethereum` | ✅ |
| Connection protocol | EIP-1193 injection | **WalletLink** (proprietary Coinbase relay — NOT WalletConnect v2) |
| Coinbase Smart Wallet (passkey/EIP-5792) | ✅ browser popup | ❌ |
| Auto-featured in AppKit modal | ✅ dedicated connector | ✅ dedicated connector |

**Critical distinction:** Coinbase Wallet mobile uses **WalletLink** — a proprietary Coinbase relay protocol, not WalletConnect v2. The QR code generated by `@coinbase/wallet-sdk` is a WalletLink QR, not a `wc:` URI. Only Coinbase Wallet mobile can scan it.

AppKit includes a built-in **Coinbase Wallet connector** that wraps `@coinbase/wallet-sdk` automatically. This connector handles WalletLink QR generation. The `coinbasePreference` config option controls behavior:

```typescript
coinbasePreference: 'all'          // Smart Wallet popup + mobile QR (default)
coinbasePreference: 'eoaOnly'      // Mobile WalletLink QR only (no Smart Wallet popup)
coinbasePreference: 'smartWalletOnly' // Smart Wallet (passkey) only
```

No separate `@coinbase/wallet-sdk` installation needed — AppKit bundles it.

---

### Bundle Size Impact

| Package | Estimated gzipped size |
|---------|----------------------|
| `@reown/appkit` | ~120 KB |
| `@reown/appkit-adapter-ethers` | ~15 KB |
| **Total addition** | ~135 KB |

AppKit is lazy-loaded (only when EVM QR modal is opened), minimizing impact on initial page load.

---

### Files Changed

| File | Change |
|------|--------|
| `web/src/lib/wallets/appkit.ts` | **New** — AppKit singleton init + `getAppKitSigner()` |
| `web/src/lib/wallets/evm.ts` | **Add** `connectEvmMobile()` |
| `web/src/components/wallet-connect.tsx` | **Add** mobile connect button + mode toggle for EVM |
| `web/src/app/providers.tsx` | **Add** `import '@/lib/wallets/appkit'` (init side-effect) |
| `web/.env.example` | **Add** `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` |
| `web/package.json` | **Add** `@reown/appkit`, `@reown/appkit-adapter-ethers` |
| `docs/prd.md` | **New** — this feature's product requirements |
| `docs/tdd.md` | **New** — this document |

Files **not changed:** `evm.ts:sendEvmTransfer`, all Solana/TON wallet code, API layer.

---

### Test Plan

| Test | Type | Tool |
|------|------|------|
| `connectEvmMobile` returns signer when AppKit provider is available | Unit | Vitest + mock appKit |
| `WalletConnect` renders "Connect Mobile Wallet" button for EVM chains | Component | @testing-library/react |
| `WalletConnect` does NOT render mobile button for Solana/TON chains | Component | @testing-library/react |
| Extension path still works when `window.ethereum` is present | Component | @testing-library/react + mock |
| Full mobile connect → pay flow (Coinbase Wallet / Rabby) | Manual E2E | Real device |

---

### Configuration Checklist

- [ ] Register project at [dashboard.reown.com](https://dashboard.reown.com)
- [ ] Store Project ID in Bitwarden under `openclawbot` collection as "Reown (WalletConnect) Project ID — CryptoPayments"
- [ ] Add `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` to:
  - [ ] `web/.env.example` (placeholder)
  - [ ] Local `.env.local` (actual value, gitignored)
  - [ ] Azure Static Web App app settings
  - [ ] Vercel project env vars (if deployed there)
  - [ ] GitHub Actions secrets (if CI builds the static export)
- [ ] Verify Rabby WalletConnect registry ID in [WalletConnect Explorer](https://explorer.walletconnect.com/?type=wallet) and update `featuredWalletIds` in `appkit.ts`
