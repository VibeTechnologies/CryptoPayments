# Payment UX Flow

Crypto payment page for OpenClaw subscriptions. Standalone Next.js SPA hosted separately from the Supabase Edge Function API.

## Architecture

```
User (browser)  ──>  Next.js SPA (Vercel/static)  ──>  Edge Function API (Supabase)
                          │                                      │
                     wallet SDKs                           on-chain verify
                   (ethers, phantom,                        + webhook to
                     tonconnect)                            OpenClawBot
```

- **SPA** (`/web`): Next.js app. Handles UI, wallet connection, tx signing.
- **API** (Supabase Edge Function): `/api/config` for chain/token/wallet data, `POST /api/payment` for tx verification.
- **No HTML from Edge Functions** — Supabase rewrites `text/html` to `text/plain`.

## Entry Points

1. **Telegram Mini App**: Bot sends a web_app button with `?plan=starter&uid=123456`. Telegram WebApp JS provides `initData` for auth.
2. **Direct link**: `https://<spa-host>/pay?plan=starter&uid=123456&idtype=tg`
3. **Checkout session**: `https://<spa-host>/checkout/<session_id>` — pre-created via `POST /v1/checkout/sessions`.

## User Flow

### Step 1 — Choose Network

User picks a blockchain network:

| Network      | Wallet        | Chain ID   |
|-------------|---------------|------------|
| Base        | MetaMask      | `0x2105`   |
| Ethereum    | MetaMask      | `0x1`      |
| Solana      | Phantom       | —          |
| TON         | TonConnect    | —          |
| Base Sepolia| MetaMask      | `0x14a34`  |

### Step 2 — Choose Token

- **USDC** (default)
- **USDT**

Both are 6 decimals on all chains.

### Step 3 — Connect Wallet

SPA detects available wallets and shows the appropriate connect button:

- **EVM chains** (Base, Ethereum, Base Sepolia): `window.ethereum` -> ethers.js v6 `BrowserProvider`
  - Auto-switches chain via `wallet_switchEthereumChain`
- **Solana**: `window.phantom.solana` -> `connect()`
- **TON**: TonConnect UI SDK -> modal

### Step 4 — Review & Pay

Page shows:
- Plan name + price (fetched from `/api/config` `.prices`)
- Receiving wallet address (from `/api/config` `.wallets[chain]`)
- Token contract address (from `/api/config` `.tokens[chain][token]`)
- "Send Payment" button

User clicks "Send Payment":
1. SPA constructs ERC-20 `transfer()` (EVM), SPL transfer (Solana), or Jetton transfer (TON)
2. Wallet popup asks user to sign
3. SPA captures the tx hash from the wallet response

### Step 5 — Verify

SPA sends `POST /api/payment`:

```json
{
  "txHash": "0x...",
  "chainId": "base",
  "token": "usdc",
  "idType": "tg",
  "uid": "123456",
  "plan": "starter",
  "callbackUrl": "https://bot.openclaw.ai/crypto-webhook",
  "initData": "<telegram_init_data>"
}
```

API verifies on-chain, returns `{ payment: { status: "verified", ... } }`.

### Step 6 — Confirmation

Page shows success state. If opened from Telegram, auto-closes after 3 seconds via `tg.close()`.

## Fallback: Manual TX Hash

If wallet connection fails or user sends from an exchange, they can:
1. Copy the receiving wallet address
2. Send the exact amount manually
3. Paste the tx hash into an input field
4. Click "Verify Payment"

## API Endpoints (consumed by SPA)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/config` | None | Wallets, prices, tokens, chains |
| `POST` | `/api/payment` | `initData` or `apiKey` | Submit tx hash for verification |
| `GET` | `/api/payment/:id` | None | Check payment status |
| `GET` | `/v1/checkout/sessions/:id` | API key | Get checkout session details |

## Design

Stripe-like minimal dark theme. Mobile-first (Telegram Mini App). Steps are collapsible cards.
