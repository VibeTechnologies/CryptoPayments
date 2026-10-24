# Product Requirements Document — CryptoPayments

## Overview

CryptoPayments is a standalone Next.js payment SPA (`pay.oclawbox.com`) that accepts USDC/USDT on Base, Ethereum, Arbitrum, Solana, and TON. It links payments to Telegram user IDs for OpenClawBot subscription billing.

---

## Feature: Mobile Wallet QR Connect (Base / Rabby Wallet)

### Status: Proposed

### Problem

The current EVM wallet connection only works via browser extension (`window.ethereum`). Users who:
- Store funds in **Coinbase Wallet mobile** (the native Base ecosystem wallet)
- Use **Rabby Wallet mobile** (popular multi-chain EVM wallet)
- Have MetaMask or any other mobile EVM wallet

…cannot pay from the desktop payment page without installing a browser extension. This creates friction for Base-native users who use Coinbase Wallet on their phone, and for DeFi users who rely on Rabby mobile.

### Goal

Allow users to **connect a mobile EVM wallet via QR code** directly from the payment page. User scans the QR with their phone, approves the connection, and signs the payment transaction — without any browser extension.

---

### User Stories

**US-1 — Desktop QR connect with Coinbase Wallet:**
> As a desktop user with Coinbase Wallet on my iPhone,
> I want to see a QR code when I click "Connect Mobile Wallet",
> so I can scan it with Coinbase Wallet, sign the payment, and complete checkout without installing an extension.

**US-2 — Desktop QR connect with Rabby mobile:**
> As a desktop user with Rabby Wallet mobile installed,
> I want to scan a WalletConnect QR code on the payment page,
> so I can connect Rabby mobile, approve the USDC transfer, and pay.

**US-3 — Mobile deep-link connect:**
> As a user viewing the payment page on mobile,
> I want to tap a "Connect with Coinbase Wallet" button that opens the app directly,
> so I don't need to scan a QR code from my own screen.

**US-4 — Extension wallets still work:**
> As a desktop user with MetaMask, Rabby browser extension, or Coinbase browser extension,
> I can still click "Connect Wallet" and it uses the browser extension — the existing flow is unchanged.

---

### Functional Requirements

| # | Requirement |
|---|---|
| FR-1 | A "Connect Mobile Wallet" option is visible on the payment page for EVM chains (Base, Ethereum, Arbitrum) |
| FR-2 | Clicking "Connect Mobile Wallet" opens a modal with a QR code that Coinbase Wallet and Rabby mobile can scan |
| FR-3 | The QR code uses the WalletConnect v2 protocol (standard WalletConnect URI) |
| FR-4 | After scanning and approving in the mobile wallet, the page shows "Connected: 0x…" and enables the Pay button |
| FR-5 | The payment transaction is sent via the connected mobile session; user approves on their phone |
| FR-6 | On mobile browsers, the "Connect Mobile Wallet" button opens a deep link to the native wallet app instead of a QR modal |
| FR-7 | The existing "Connect Wallet" extension path remains unchanged for extension users |
| FR-8 | The modal includes featured wallet entries for **Coinbase Wallet** and **Rabby Wallet** |
| FR-9 | Chain switching (`wallet_switchEthereumChain`) works through the WalletConnect session |

---

### Wallet Compatibility

#### Coinbase Wallet (Base native)
- Mobile app: iOS + Android ✅
- WalletConnect v2 QR scanning: ✅ supported
- Deep link on mobile: `cbwallet://` universal link ✅
- Also available as browser extension (already covered by existing `window.ethereum` path)
- Note: Coinbase Smart Wallet (EIP-5792, passkey-based) is a separate product; this feature targets Coinbase Wallet mobile.

#### Rabby Wallet
- Desktop: Browser extension only (Chrome/Firefox) — already works via `window.ethereum`
- Mobile app: iOS + Android ✅ (launched 2024)
- WalletConnect v2 QR scanning: ✅ supported — Rabby mobile can scan any WalletConnect v2 URI
- Deep link on mobile: ✅ via WalletConnect universal link
- **Note on "login"**: Rabby does not have its own session/login protocol for web apps. Web dApp connection is entirely via WalletConnect v2 scanning on mobile, or via browser extension on desktop. There is no proprietary Rabby auth flow.

#### Other wallets via the same QR
The WalletConnect modal supports 300+ wallets. The same QR code works for MetaMask Mobile, Trust Wallet, Rainbow, etc. No additional per-wallet integration is needed.

---

### Non-Functional Requirements

| # | Requirement |
|---|---|
| NFR-1 | QR modal loads in < 2 seconds |
| NFR-2 | Bundle size increase ≤ 150 KB gzipped from AppKit packages |
| NFR-3 | Requires one Reown Project ID (free tier, stored in env var `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`) |
| NFR-4 | Works in Telegram Mini App WebView (where `window.ethereum` is absent) |
| NFR-5 | Static export compatibility maintained (no server-side rendering of AppKit components) |

---

### Out of Scope

- Rabby proprietary session login (does not exist — WalletConnect is the only mobile connect mechanism)
- WalletConnect for Solana (Phantom has its own deep link; TON uses TonConnect already)
- Sign-In with Ethereum (SIWE) authentication — this is a payment flow, not an auth flow
- Coinbase Smart Wallet (EIP-5792/passkey) — separate product, different use case

---

### Acceptance Criteria

- [ ] AC-1: Desktop user can open QR modal, scan with Coinbase Wallet mobile, and complete a USDC payment on Base
- [ ] AC-2: Desktop user can open QR modal, scan with Rabby Wallet mobile, and complete a USDC payment on Base
- [ ] AC-3: Mobile user tapping "Connect Mobile Wallet" is directed to native wallet app via deep link
- [ ] AC-4: Extension users (MetaMask, Rabby extension, Coinbase extension) still connect via existing button — no regression
- [ ] AC-5: No increase in payment submission failures; existing API/verification flow unchanged

---

## Existing Feature Reference

### Payment Flows (current, stable)

| Chain | Wallet | Status |
|-------|--------|--------|
| Base / Ethereum / Arbitrum | Browser extension (MetaMask, Rabby, Coinbase) | ✅ Live |
| Solana | Phantom browser extension | ✅ Live |
| TON | TonConnect QR + mobile deep link | ✅ Live |
| Base / Ethereum / Arbitrum | **Mobile QR (WalletConnect v2)** | 🔲 This feature |

### Entry Points

1. Telegram Mini App: `?plan=starter&uid=123456` via `web_app` button
2. Direct link: `https://pay.oclawbox.com/pay?plan=starter&uid=123456&idtype=tg`
3. Checkout session: `https://pay.oclawbox.com/checkout/<session_id>`

### API Endpoints (unchanged)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/config` | Chain/token/wallet addresses |
| `POST` | `/api/payment` | Submit tx hash for on-chain verification |
| `GET` | `/api/payment/:id` | Check payment status |
