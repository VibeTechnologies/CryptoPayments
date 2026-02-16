---
name: cryptopayments-integration
description: Deploy CryptoPayments on Supabase Edge Functions and integrate with OpenClawBot. Covers Supabase setup, Edge Function deployment, Stripe-like API, webhook contract, and operational diagnostics.
---

# CryptoPayments Integration

Deploy and integrate CryptoPayments — a Telegram Mini App for accepting USDT/USDC payments on Base, Ethereum, TON, and Solana. Runs entirely on **Supabase** (Edge Functions + Postgres). Integrates with OpenClawBot via HMAC-signed webhook callbacks.

## Architecture Overview

```
Telegram User
  │
  ├── /plans → OpenClawBot
  │     └── "Pay with Crypto" button → opens Mini App
  │
  ├── Mini App (Supabase Edge Function)
  │     ├── GET /                      → Payment page HTML
  │     ├── GET /checkout/:id          → Checkout session page
  │     ├── GET /api/config            → Wallet addresses, prices, token addresses
  │     ├── POST /api/payment          → Legacy: submit tx hash for verification
  │     ├── POST /v1/checkout/sessions → Stripe-like: create checkout session
  │     │
  │     └── On payment verification:
  │           ├── On-chain verify (viem / TonCenter / Solana RPC)
  │           ├── Record in Supabase Postgres
  │           └── POST callback → OpenClawBot /crypto/webhook
  │
  └── OpenClawBot (webhook receiver, port 3003)
        ├── Verify HMAC-SHA256 signature
        ├── Idempotency check (crypto_tx_hash UNIQUE)
        ├── activateSubscription() + provisionAndNotify()
        └── User gets subscription + tenant provisioned
```

**Key principles:**
- **Fully backendless** — No Docker, no K8s deployment for CryptoPayments. Supabase Edge Functions for compute, Supabase Postgres for storage.
- **Stripe-like API** — Customers, invoices, line items, payment intents, checkout sessions, webhook events. Stripe-style prefixed IDs (`cus_`, `inv_`, `il_`, `pi_`, `cs_`, `evt_`).
- CryptoPayments verifies on-chain transactions. OpenClawBot trusts the webhook callback (after HMAC verification) and activates subscriptions.

## Prerequisites

- Supabase CLI installed (`brew install supabase/tap/supabase`)
- Supabase project linked (`supabase link --project-ref <project-ref>`)
- `pnpm` for local development
- Node.js 22+ (for local dev/testing via `tsx`)

## Service Details

| Property | Value |
|----------|-------|
| **Repo** | `VibeTechnologies/CryptoPayments` |
| **Runtime** | Deno (Supabase Edge Functions) / Node.js 22 (local dev) |
| **Framework** | Hono (runtime-agnostic) |
| **Database** | Supabase Postgres via `@supabase/supabase-js` |
| **Supabase Project** | `wxxnkncwneyhmudfyayd` |
| **API URL** | `https://wxxnkncwneyhmudfyayd.supabase.co` |
| **Edge Function URL** | `https://wxxnkncwneyhmudfyayd.supabase.co/functions/v1/crypto-payments/` |
| **Dashboard** | https://supabase.com/dashboard/project/wxxnkncwneyhmudfyayd |
| **Region** | East US (North Virginia) |

### Chains & Tokens

| Chain | Token | Decimals | Verification Method |
|-------|-------|----------|-------------------|
| Base | USDT, USDC | 6 | viem (EVM RPC) |
| Ethereum | USDT, USDC | 6 | viem (EVM RPC) |
| TON | USDT, USDC | 6 | TonCenter REST API |
| Solana | USDT, USDC | 6 | Solana JSON-RPC |

### Plan Pricing

| Plan | Price USD | Tolerance |
|------|-----------|-----------|
| starter | $10 | 1% ($9.90–$10.10) |
| pro | $25 | 1% ($24.75–$25.25) |
| max | $100 | 1% ($99.00–$101.00) |

**Amounts stored in cents** (integer) in the Stripe-like schema, converted to dollars for the legacy compatibility layer.

### Generated Wallet Addresses

| Chain | Address |
|-------|---------|
| EVM (Base/ETH) | `0x22Cdc7925ffAb409EbCA5ab8c912Fcd8E2644acD` |
| TON | `UQDQx44DMgyzrR0XFgdX6XWFeAiVKiCZzLd4-pBeotG4xeE7` |
| Solana | `3z6XF6mRAoT59mgLFwQTUmWdjeC6r5ttJr3AYv7Mootc` |

## Environment Configuration

### CryptoPayments Service (`.env` for local dev)

```bash
# Supabase (auto-injected in Edge Functions — only needed locally)
SUPABASE_URL=https://wxxnkncwneyhmudfyayd.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...

# Server (local dev only)
PORT=3003
BASE_URL=https://pay.openclaw.ai

# Receiving wallet addresses (one per chain)
WALLET_BASE=0x...
WALLET_ETH=0x...
WALLET_TON=UQ...
WALLET_SOL=...

# RPC endpoints (defaults to public endpoints)
RPC_BASE=https://mainnet.base.org
RPC_ETH=https://cloudflare-eth.com
RPC_SOL=https://api.mainnet-beta.solana.com
RPC_TON=https://toncenter.com/api/v3

# Plan prices
PRICE_STARTER=10
PRICE_PRO=25
PRICE_MAX=100

# Telegram bot token (for Mini App initData HMAC verification)
TELEGRAM_BOT_TOKEN=

# Auth
API_KEY=cpk_...        # API key for bot → payment service calls
CALLBACK_SECRET=       # HMAC-SHA256 key for webhook callbacks
```

**Note:** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected in Edge Functions. You cannot manually set them via `supabase secrets set`.

### Supabase Edge Function Secrets

Set via `supabase secrets set`:

```bash
supabase secrets set \
  WALLET_BASE=0x... \
  WALLET_ETH=0x... \
  WALLET_TON=UQ... \
  WALLET_SOL=... \
  API_KEY=cpk_... \
  CALLBACK_SECRET=... \
  TELEGRAM_BOT_TOKEN=...
```

### OpenClawBot (`.env` additions)

```bash
CRYPTO_PAYMENTS_ENABLED=true
CRYPTO_PAYMENTS_URL=https://wxxnkncwneyhmudfyayd.supabase.co/functions/v1/crypto-payments
CRYPTO_PAYMENTS_API_KEY=cpk_...         # Same as CryptoPayments API_KEY
CRYPTO_CALLBACK_SECRET=                  # Same as CryptoPayments CALLBACK_SECRET
CRYPTO_WEBHOOK_PORT=3003                 # HTTP server port for webhook receiver
```

**Critical**: `CRYPTO_CALLBACK_SECRET` in OpenClawBot must match `CALLBACK_SECRET` in CryptoPayments. Generate with: `openssl rand -hex 32`

## Deployment (Supabase Edge Function)

### How It Works

The Hono app in `src/server.ts` exports a `createApp()` factory that returns a runtime-agnostic Hono `app`. The Edge Function entry point at `supabase/functions/crypto-payments/index.ts` imports this app, strips the `/crypto-payments` path prefix (added by Supabase routing), and calls `Deno.serve()`.

Because Supabase can only deploy files within `supabase/`, the `predeploy:edge` script copies `src/` into `supabase/functions/crypto-payments/src/` before deployment. This copied directory is gitignored.

### Import Resolution

Bare specifiers (`hono`, `viem`, `@supabase/supabase-js`) are mapped via `supabase/functions/crypto-payments/deno.json`:

```json
{
  "imports": {
    "hono": "npm:hono@4",
    "hono/": "npm:hono@4/",
    "viem": "npm:viem@2",
    "viem/": "npm:viem@2/",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2"
  }
}
```

### Deploy Steps

```bash
# 1. Deploy Edge Function (copies src/ and deploys)
pnpm deploy:edge

# This runs:
#   pnpm predeploy:edge  →  cp -r src/ supabase/functions/crypto-payments/src/
#   supabase functions deploy crypto-payments --no-verify-jwt

# 2. Verify
curl -s https://wxxnkncwneyhmudfyayd.supabase.co/functions/v1/crypto-payments/api/health
# Expected: {"ok":true,"chains":["base","eth","ton","sol"],"tokens":["usdt","usdc"]}

# 3. Set secrets (if not already done)
supabase secrets set WALLET_BASE=0x... API_KEY=cpk_... CALLBACK_SECRET=...
```

### Local Development

```bash
pnpm install
pnpm dev        # Watch mode via tsx (Node.js runtime)
pnpm build      # TypeScript type-check only (no JS emit)
pnpm test       # 45 tests via vitest
```

**Note:** `pnpm build` only type-checks (`noEmit: true` in tsconfig). The codebase uses `.ts` extension imports with `allowImportingTsExtensions: true`. Locally it runs via `tsx`, in production via Deno.

### Dual-Runtime Compatibility

The `config.ts` env helper supports both Deno and Node.js:

```typescript
const g = globalThis as any;
if (g.Deno?.env?.get) return g.Deno.env.get(key);
else return g.process?.env?.[key];
```

## API Endpoints (24 total)

### Public (No Auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Payment page HTML (Telegram Mini App) |
| GET | `/checkout/:id` | Checkout session page HTML |
| GET | `/api/health` | Health check |
| GET | `/api/config` | Wallet addresses, prices, token addresses |

### Legacy API (API key or initData)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/payment` | initData or API key | Submit tx hash for verification |
| GET | `/api/payment/:id` | API key | Get payment by ID |
| GET | `/api/payments` | API key | List payments for a user |

### Stripe-like API (`/v1/*`, API key via `x-api-key` header)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/customers` | Create customer |
| GET | `/v1/customers/:id` | Retrieve customer |
| GET | `/v1/customers` | List customers |
| POST | `/v1/invoices` | Create invoice |
| GET | `/v1/invoices/:id` | Retrieve invoice |
| GET | `/v1/invoices` | List invoices |
| POST | `/v1/invoices/:id/line_items` | Add line item to invoice |
| POST | `/v1/payment_intents` | Create payment intent |
| GET | `/v1/payment_intents/:id` | Retrieve payment intent |
| POST | `/v1/payment_intents/:id/verify` | Verify payment on-chain |
| POST | `/v1/checkout/sessions` | Create checkout session |
| GET | `/v1/checkout/sessions/:id` | Retrieve checkout session |
| GET | `/v1/events` | List webhook events |
| GET | `/v1/events/:id` | Retrieve event |

### Authentication

- **API routes**: `x-api-key` header or `api_key` query parameter
- **Legacy POST /api/payment**: Either Telegram `initData` (Mini App HMAC) or API key
- **Public HTML/health/config**: No auth required

### Stripe-like Object IDs

| Prefix | Object |
|--------|--------|
| `cus_` | Customer |
| `inv_` | Invoice |
| `il_` | Line Item |
| `pi_` | Payment Intent |
| `cs_` | Checkout Session |
| `evt_` | Event |

## Database Schema (Supabase Postgres)

Six Stripe-like tables plus one legacy table. Schema in `supabase/schema.sql` (190 lines).

| Table | Primary Key | Description |
|-------|-------------|-------------|
| `customers` | `id` (cus_...) | Customer records |
| `invoices` | `id` (inv_...) | Invoice records with status tracking |
| `line_items` | `id` (il_...) | Invoice line items (amount in cents) |
| `payment_intents` | `id` (pi_...) | Payment intents with chain/token/tx info |
| `checkout_sessions` | `id` (cs_...) | Checkout session state |
| `events` | `id` (evt_...) | Webhook event log |
| `payments` | `id` (uuid) | Legacy payments table |

## Webhook Contract

CryptoPayments sends a POST webhook to OpenClawBot when a payment is verified on-chain.

### Callback URL

Caller-supplied — OpenClawBot passes `callbackUrl` in the payment request body. CryptoPayments calls `sendCallback(callbackUrl, payment)` (in `server.ts:557`) after successful on-chain verification.

### Request Format

```
POST /crypto/webhook HTTP/1.1
Content-Type: application/json
X-Signature: <HMAC-SHA256 hex digest of body>
X-Timestamp: <Unix seconds string>
```

**Body:**
```json
{
  "event": "payment.verified",
  "payment": {
    "id": "uuid-v4",
    "idType": "telegram",
    "uid": "123456789",
    "plan": "pro",
    "chain": "base",
    "token": "usdc",
    "amountUsd": "25.00",
    "txHash": "0xabc123..."
  },
  "timestamp": "1700000000"
}
```

### Signature Verification

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

const expectedSig = createHmac("sha256", CALLBACK_SECRET)
  .update(rawBody)
  .digest("hex");

const valid = timingSafeEqual(
  Buffer.from(signature),
  Buffer.from(expectedSig)
);
```

### Security Measures (OpenClawBot webhook handler)

1. **HMAC-SHA256** — constant-time comparison of `X-Signature` header
2. **Timestamp validation** — rejects requests older than 5 minutes
3. **Rate limiting** — per-IP sliding window
4. **Body size limit** — rejects payloads > 10KB
5. **POST-only** — rejects all other HTTP methods
6. **Idempotency** — `crypto_tx_hash` UNIQUE column prevents double-activation
7. **Fire-and-forget** — returns 200 immediately, processes async

### Response

- `200` — Webhook received (processing is async)
- `401` — Invalid signature
- `405` — Method not allowed
- `429` — Rate limited

## Integration Points with OpenClawBot

### Files Modified in OpenClawBot

| File | Changes |
|------|---------|
| `src/config.ts` | 5 crypto config fields (enabled, URL, API key, callback secret, webhook port) |
| `src/db/schema.ts` | `cryptoTxHash` column in payments table |
| `src/db/client.ts` | CREATE TABLE, ALTER TABLE migration, unique index for `crypto_tx_hash` |
| `src/db/payments.ts` | `getPaymentByCryptoTxHash()`, extended `RecordPaymentInput` |
| `src/payments/success.ts` | `"crypto"` in paymentMethod union, `cryptoTxHash` routing |
| `src/payments/wallet-pay-flow.ts` | "Pay with Crypto" button in `buildPaymentMethodKeyboard()` |
| `src/commands/plans.ts` | `pay_crypto:` callback handler, Mini App `webApp` button |
| `src/index.ts` | Crypto webhook HTTP server on port 3003 + graceful shutdown |
| `.env.example` | 5 new env vars |
| `docs/payments.md` | CryptoPayments documentation section |

### Files Created in OpenClawBot

| File | Description |
|------|-------------|
| `src/payments/crypto-webhook.ts` | Webhook handler (~310 LOC): HMAC verify, rate limit, async processing |
| `tests/crypto-webhook.test.ts` | 20+ tests for webhook handler |

### Payment Method Flow

```
"stars"      → Telegram Stars API → pre_checkout_query / successful_payment
"wallet_pay" → Wallet Pay API → webhook with order ID
"crypto"     → CryptoPayments Mini App → webhook with tx hash
```

All three converge at `activateSubscription()` + `provisionAndNotify()`.

### Mini App URL Construction

OpenClawBot builds the Mini App URL in `src/commands/plans.ts:217`:

```typescript
`${cryptoPaymentsUrl}/pay?plan=${planId}&uid=${ctx.from.id}`
```

Where `cryptoPaymentsUrl` defaults to the Edge Function URL.

## OpenClawBot K8s Configuration

The OpenClawBot deployment needs these additions to support the crypto webhook receiver:

### Required K8s Secret Keys

Add to `openclaw-bot-secret`:

| Key | Description |
|-----|-------------|
| `CRYPTO_CALLBACK_SECRET` | HMAC-SHA256 shared secret (same as CryptoPayments CALLBACK_SECRET) |
| `CRYPTO_PAYMENTS_API_KEY` | API key for bot → CryptoPayments calls |

### Required Deployment Env Vars

```yaml
- name: CRYPTO_PAYMENTS_ENABLED
  value: "true"
- name: CRYPTO_PAYMENTS_URL
  value: "https://wxxnkncwneyhmudfyayd.supabase.co/functions/v1/crypto-payments"
- name: CRYPTO_PAYMENTS_API_KEY
  valueFrom:
    secretKeyRef:
      name: openclaw-bot-secret
      key: CRYPTO_PAYMENTS_API_KEY
- name: CRYPTO_CALLBACK_SECRET
  valueFrom:
    secretKeyRef:
      name: openclaw-bot-secret
      key: CRYPTO_CALLBACK_SECRET
- name: CRYPTO_WEBHOOK_PORT
  value: "3003"
```

### Required Service/Ingress

- Service: expose port 3003 (targetPort 3003) named `crypto-webhook`
- Deployment: add `containerPort: 3003` named `crypto-webhook`
- Ingress may need a route if the Edge Function sends callbacks to the external URL

## Diagnostics

### Health Check

```bash
# Edge Function
curl -s https://wxxnkncwneyhmudfyayd.supabase.co/functions/v1/crypto-payments/api/health

# Config endpoint
curl -s https://wxxnkncwneyhmudfyayd.supabase.co/functions/v1/crypto-payments/api/config
```

### Database Inspection (Supabase)

Use the Supabase dashboard SQL editor or the API:

```bash
# List recent payments (via Supabase REST API)
curl -s "https://wxxnkncwneyhmudfyayd.supabase.co/rest/v1/payments?order=created_at.desc&limit=10" \
  -H "apikey: <service_role_key>" \
  -H "Authorization: Bearer <service_role_key>"

# List recent invoices
curl -s "https://wxxnkncwneyhmudfyayd.supabase.co/rest/v1/invoices?order=created_at.desc&limit=10" \
  -H "apikey: <service_role_key>" \
  -H "Authorization: Bearer <service_role_key>"
```

Or use the Stripe-like API:

```bash
curl -s "https://wxxnkncwneyhmudfyayd.supabase.co/functions/v1/crypto-payments/v1/invoices?limit=10" \
  -H "x-api-key: cpk_..."
```

### Edge Function Logs

```bash
# Tail live logs
supabase functions logs crypto-payments --tail

# Recent logs
supabase functions logs crypto-payments
```

### OpenClawBot Webhook Receiver

```bash
# Check if webhook server is running (from within the cluster)
kubectl exec deploy/openclaw-bot -c bot -- \
  curl -s -o /dev/null -w '%{http_code}' \
  -X POST http://localhost:3003/crypto/webhook \
  -H "Content-Type: application/json" \
  -d '{}'
# Expected: 401 (missing signature — proves server is listening)
```

### Common Issues

| Symptom | Diagnosis | Fix |
|---------|-----------|-----|
| Mini App blank | Edge Function not deployed | Run `pnpm deploy:edge` |
| Webhook 401 | `CALLBACK_SECRET` mismatch | Ensure same secret in both services |
| Webhook not received | Port 3003 not exposed | Add containerPort + service port in K8s |
| Tx verification fails | RPC endpoint down | Check logs, switch to paid RPC provider |
| Import error in Edge Function | Missing `npm:` specifier | Update `deno.json` import map |
| `SUPABASE_URL` not found | Trying to set auto-injected vars | Remove from `supabase secrets set` — these are auto-injected |
| Payment stuck "pending" | On-chain verification timeout | Check Edge Function logs |
| Duplicate activation | Should not happen | `crypto_tx_hash` UNIQUE constraint prevents this |

## File Map

### CryptoPayments Repo

```
CryptoPayments/
  src/
    config.ts          # Dual-runtime env helper, wallet/RPC/plan config
    db.ts              # Supabase client, all Stripe-like CRUD operations
    server.ts          # Hono app, 24 endpoints, sendCallback()
    telegram.ts        # Async verifyTelegramInitData (Web Crypto API)
    verify.ts          # On-chain tx verification (EVM/TON/Solana)
  supabase/
    config.toml        # Supabase project config
    schema.sql         # Full Postgres DDL (6 tables + legacy)
    migrations/        # Applied SQL migrations
    functions/
      crypto-payments/
        index.ts       # Edge Function entry point (19 lines)
        deno.json      # Deno import map (npm: specifiers)
        src/           # GITIGNORED — copied from src/ at deploy time
  scripts/
    crypto-seed.ts     # Wallet generation + geth keystore V3 encryption
  tests/
    server.test.ts     # 18 tests
    telegram.test.ts   # 9 tests
    verify.test.ts     # 10 tests
    payments.test.ts   # 8 tests
  .env                 # Local env vars (never commit)
  deno.json            # Root import map
  tsconfig.json        # allowImportingTsExtensions, noEmit
  package.json         # Scripts: dev, build, test, deploy:edge
```

### OpenClawBot Files (crypto-related)

```
OpenClawBot/
  src/
    config.ts                     # Lines 143-205: crypto config loading
    index.ts                      # Crypto webhook HTTP server + shutdown
    commands/plans.ts             # Line 217: Mini App URL construction
    payments/
      wallet-pay-flow.ts          # "Pay with Crypto" button
      crypto-webhook.ts           # Webhook handler (310 LOC)
      success.ts                  # "crypto" payment method routing
    db/
      schema.ts                   # cryptoTxHash column
      client.ts                   # Migration + unique index
      payments.ts                 # getPaymentByCryptoTxHash()
  tests/
    crypto-webhook.test.ts        # 20+ tests
  k8s/bot/
    deployment.yaml               # Needs crypto env vars + containerPort 3003
    service.yaml                  # Needs port 3003
    ingress.yaml                  # May need webhook route
  .github/workflows/bot-image.yml # Needs crypto secret sync
```

## Running Tests

### CryptoPayments (45 tests)

```bash
cd /path/to/CryptoPayments
pnpm test
```

### OpenClawBot (212 tests total, including crypto)

```bash
cd /path/to/OpenClawBot
pnpm test                              # All tests
pnpm test tests/crypto-webhook.test.ts # Crypto webhook tests only
```
