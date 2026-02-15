---
name: cryptopayments-integration
description: Deploy CryptoPayments service and integrate it with OpenClawBot. Covers Docker build, K8s deployment on AKS, environment configuration, webhook contract, security, and operational diagnostics.
---

# CryptoPayments Integration

Deploy and integrate the CryptoPayments service — a Telegram Mini App for accepting USDT/USDC payments on Base, Ethereum, TON, and Solana. Integrates with OpenClawBot via HMAC-signed webhook callbacks.

## Architecture Overview

```
Telegram User
  │
  ├── /plans → OpenClawBot
  │     └── "Pay with Crypto" button → opens Mini App
  │
  ├── Mini App (pay.oclawbox.com)
  │     ├── GET /                → Payment page HTML
  │     ├── GET /api/config      → Wallet addresses, prices, token addresses
  │     └── POST /api/payment    → Submit tx hash for verification
  │           ├── On-chain verify (viem/TonCenter/Solana RPC)
  │           ├── Record in SQLite
  │           └── POST callback → OpenClawBot /crypto/webhook
  │
  └── OpenClawBot (webhook receiver)
        ├── Verify HMAC-SHA256 signature
        ├── Idempotency check (crypto_tx_hash UNIQUE)
        ├── activateSubscription() + provisionAndNotify()
        └── User gets subscription + tenant provisioned
```

**Key principle**: CryptoPayments verifies on-chain transactions. OpenClawBot trusts the webhook callback (after HMAC verification) and activates subscriptions.

## Prerequisites

- AKS cluster running (`openclaw-aks`) with Traefik ingress and wildcard TLS
- `kubectl` configured: `export KUBECONFIG=./infra/terraform/kubeconfig`
- `ghcr-pull` image pull secret in `default` namespace
- `openclaw-bot-secret` with `TELEGRAM_BOT_TOKEN` (shared by CryptoPayments)
- Docker + pnpm for local development

## Service Details

| Property | Value |
|----------|-------|
| **Repo** | `VibeTechnologies/CryptoPayments` |
| **Runtime** | Node.js 22, TypeScript (ESM) |
| **Framework** | Hono + `@hono/node-server` |
| **Database** | SQLite via `better-sqlite3` |
| **Image** | `ghcr.io/vibetechnologies/crypto-payments:latest` |
| **Port** | 3003 |
| **External URL** | `https://pay.oclawbox.com` |
| **In-cluster URL** | `http://crypto-payments.default.svc.cluster.local:3003` |
| **Namespace** | `default` |

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
| starter | $10 | 1% ($9.90-$10.10) |
| pro | $25 | 1% ($24.75-$25.25) |
| max | $100 | 1% ($99.00-$101.00) |

## Environment Configuration

### CryptoPayments Service (`.env`)

```bash
# Server
PORT=3003
BASE_URL=https://pay.oclawbox.com     # IMPORTANT: match K8s ingress host
DATABASE_URL=./data/payments.db

# Receiving wallet addresses (one per chain)
WALLET_BASE=0x...
WALLET_ETH=0x...
WALLET_TON=UQ...
WALLET_SOL=...

# RPC endpoints (defaults to public endpoints — use paid RPCs in production)
RPC_BASE=https://mainnet.base.org
RPC_ETH=https://cloudflare-eth.com
RPC_SOL=https://api.mainnet-beta.solana.com
RPC_TON=https://toncenter.com/api/v3

# Plan prices (matched against on-chain stablecoin amount)
PRICE_STARTER=10
PRICE_PRO=25
PRICE_MAX=100

# Telegram bot token (for Mini App initData HMAC verification)
TELEGRAM_BOT_TOKEN=

# Auth
API_KEY=                # Shared secret for bot → payment service API calls
CALLBACK_SECRET=        # HMAC-SHA256 key for webhook callbacks to OpenClawBot
```

### OpenClawBot (`.env` additions)

```bash
CRYPTO_PAYMENTS_ENABLED=true
CRYPTO_PAYMENTS_URL=https://pay.oclawbox.com     # CryptoPayments external URL
CRYPTO_PAYMENTS_API_KEY=                           # Same as CryptoPayments API_KEY
CRYPTO_CALLBACK_SECRET=                            # Same as CryptoPayments CALLBACK_SECRET
CRYPTO_WEBHOOK_PORT=3003                           # HTTP server port for webhook receiver
```

**Critical**: `CRYPTO_CALLBACK_SECRET` in OpenClawBot must match `CALLBACK_SECRET` in CryptoPayments. Generate with: `openssl rand -hex 32`

### BASE_URL Mismatch Warning

The CryptoPayments config defaults to `https://pay.openclaw.ai` but the K8s ingress is configured for `pay.oclawbox.com`. Always set `BASE_URL=https://pay.oclawbox.com` explicitly in both the env and K8s deployment to avoid incorrect Mini App URLs.

## Deployment (Kubernetes)

### K8s Resources

| Resource | File | Description |
|----------|------|-------------|
| Deployment | `k8s/deployment.yaml` | 1 replica, RollingUpdate, `ghcr.io/vibetechnologies/crypto-payments:latest` |
| Service | `k8s/service.yaml` | ClusterIP on port 3003 |
| IngressRoute | `k8s/ingress.yaml` | Traefik: `pay.oclawbox.com` → port 3003 |
| PVC | `k8s/pvc.yaml` | `crypto-payments-data` 1Gi RWO (SQLite) |
| Kustomization | `k8s/kustomization.yaml` | Namespace: `default` |

### Secrets Required

Two K8s secrets are referenced:

**`crypto-payments-secret`** (must create manually):
```bash
kubectl create secret generic crypto-payments-secret \
  --from-literal=WALLET_BASE=0x... \
  --from-literal=WALLET_ETH=0x... \
  --from-literal=WALLET_TON=UQ... \
  --from-literal=WALLET_SOL=... \
  --from-literal=API_KEY=$(openssl rand -hex 32) \
  --from-literal=CALLBACK_SECRET=$(openssl rand -hex 32) \
  --from-literal=RPC_BASE=https://mainnet.base.org \
  --from-literal=RPC_ETH=https://cloudflare-eth.com \
  --from-literal=RPC_SOL=https://api.mainnet-beta.solana.com \
  --from-literal=RPC_TON=https://toncenter.com/api/v3
```

**`openclaw-bot-secret`** (already exists — shared for `TELEGRAM_BOT_TOKEN`)

### Deploy Steps

```bash
export KUBECONFIG=./infra/terraform/kubeconfig

# 1. Create secret (if not exists)
kubectl create secret generic crypto-payments-secret \
  --from-literal=WALLET_BASE=0x... \
  --from-literal=WALLET_ETH=0x... \
  --from-literal=WALLET_TON=UQ... \
  --from-literal=WALLET_SOL=... \
  --from-literal=API_KEY=<shared-api-key> \
  --from-literal=CALLBACK_SECRET=<shared-callback-secret>

# 2. Apply all K8s resources
kubectl apply -k k8s/

# 3. Wait for rollout
kubectl rollout status deployment/crypto-payments --timeout=120s

# 4. Verify
curl -s https://pay.oclawbox.com/api/health | python3 -m json.tool
# Expected: {"ok":true,"chains":["base","eth","ton","sol"],"tokens":["usdt","usdc"]}
```

### Docker Build (Local / CI)

```bash
# Build
docker build -t ghcr.io/vibetechnologies/crypto-payments:latest .

# Run locally
docker run -p 3003:3003 \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  ghcr.io/vibetechnologies/crypto-payments:latest

# Push to GHCR
docker push ghcr.io/vibetechnologies/crypto-payments:latest
```

### Local Development

```bash
pnpm install
pnpm dev        # Watch mode (tsx)
pnpm build      # TypeScript → dist/
pnpm test       # 48 tests via vitest
pnpm start      # Production: node dist/server.js
```

## Webhook Contract

CryptoPayments sends a POST webhook to OpenClawBot when a payment is verified on-chain.

### Callback URL

Constructed by the caller when submitting `POST /api/payment`. OpenClawBot constructs:
```
{botBaseUrl}/crypto/webhook
```

The CryptoPayments service calls `sendCallback(callbackUrl, payment)` after successful on-chain verification.

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
  .update(rawBody)      // raw JSON string, not parsed
  .digest("hex");

const valid = timingSafeEqual(
  Buffer.from(signature),
  Buffer.from(expectedSig)
);
```

### Security Measures (OpenClawBot webhook handler)

1. **HMAC-SHA256** — constant-time comparison of `X-Signature` header
2. **Timestamp validation** — rejects requests with `X-Timestamp` older than 5 minutes
3. **Rate limiting** — per-IP sliding window
4. **Body size limit** — rejects payloads > 10KB
5. **POST-only** — rejects all other HTTP methods
6. **Idempotency** — `crypto_tx_hash` UNIQUE column prevents double-activation
7. **Fire-and-forget** — returns 200 immediately, processes async

### Response

- `200` — Webhook received (processing is async)
- `401` — Invalid signature
- `405` — Method not allowed (non-POST)
- `429` — Rate limited

## API Endpoints (CryptoPayments Service)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | None | Payment page (Telegram Mini App HTML) |
| GET | `/api/health` | None | Health check |
| GET | `/api/config` | None | Wallet addresses, prices, token addresses |
| POST | `/api/payment` | initData or API key | Submit tx hash for verification |
| GET | `/api/payments` | API key | List payments for a user |

### POST /api/payment

**Body:**
```json
{
  "txHash": "0xabc...",
  "chainId": "base",
  "token": "usdc",
  "idType": "telegram",
  "uid": "123456789",
  "plan": "pro",
  "callbackUrl": "https://bot-internal-url/crypto/webhook",
  "initData": "...",
  "apiKey": "..."
}
```

Auth: Either `initData` (Telegram Mini App HMAC) or `apiKey` (server-to-server). At least one required.

**Flow:** Insert pending payment → verify on-chain → mark verified → send webhook callback → return result.

## Integration Points with OpenClawBot

### Files Modified in OpenClawBot

| File | Changes |
|------|---------|
| `src/config.ts` | 5 new config fields (cryptoPaymentsEnabled, URL, API key, callback secret, webhook port) |
| `src/db/schema.ts` | `cryptoTxHash` column in payments table |
| `src/db/client.ts` | CREATE TABLE, ALTER TABLE migration, unique index for `crypto_tx_hash` |
| `src/db/payments.ts` | `getPaymentByCryptoTxHash()`, extended `RecordPaymentInput` |
| `src/payments/success.ts` | `"crypto"` in paymentMethod union, `cryptoTxHash` routing |
| `src/payments/wallet-pay-flow.ts` | "Pay with Crypto" button in `buildPaymentMethodKeyboard()` |
| `src/commands/plans.ts` | `pay_crypto:` callback handler, Mini App `webApp` button |
| `src/index.ts` | Crypto webhook HTTP server wiring + graceful shutdown |
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

## Diagnostics

### Health Check

```bash
# External
curl -s https://pay.oclawbox.com/api/health | python3 -m json.tool

# In-cluster
kubectl exec deploy/openclaw-bot -c bot -- \
  curl -s http://crypto-payments.default.svc.cluster.local:3003/api/health
```

### Pod Status

```bash
kubectl get pods -l app=crypto-payments -o wide
kubectl logs -l app=crypto-payments --tail=50
kubectl describe pod -l app=crypto-payments
```

### Database Inspection

```bash
PAYMENTS_POD=$(kubectl get pods -l app=crypto-payments -o jsonpath='{.items[0].metadata.name}')

# List recent payments
kubectl exec $PAYMENTS_POD -- node -e "
const db = require('better-sqlite3')('/data/payments.db');
console.log(JSON.stringify(db.prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT 10').all(), null, 2));
"

# Check pending (unverified) payments
kubectl exec $PAYMENTS_POD -- node -e "
const db = require('better-sqlite3')('/data/payments.db');
console.log(JSON.stringify(db.prepare('SELECT * FROM payments WHERE status = \"pending\"').all(), null, 2));
"
```

### Webhook Connectivity Test

```bash
# From CryptoPayments pod → OpenClawBot webhook endpoint (in-cluster)
kubectl exec deploy/crypto-payments -- \
  curl -s -o /dev/null -w '%{http_code}' \
  -X POST http://openclaw-bot.default.svc.cluster.local:3003/crypto/webhook \
  -H "Content-Type: application/json" \
  -d '{}'
# Expected: 401 (missing signature — proves connectivity)
```

### Common Issues

| Symptom | Diagnosis | Fix |
|---------|-----------|-----|
| Mini App blank | `BASE_URL` mismatch | Set `BASE_URL=https://pay.oclawbox.com` in deployment |
| Webhook 401 | `CALLBACK_SECRET` mismatch | Ensure same secret in both services |
| Webhook not received | Network/port issue | Check OpenClawBot webhook server is running on `CRYPTO_WEBHOOK_PORT` |
| Tx verification fails | RPC endpoint down | Check RPC endpoint, switch to paid provider |
| `ImagePullBackOff` | GHCR auth | Verify `ghcr-pull` secret exists |
| Payment stuck "pending" | On-chain verification timeout | Check logs, verify tx on block explorer |
| Duplicate activation | Should not happen | `crypto_tx_hash` UNIQUE constraint prevents this |

### Verify TLS

```bash
curl -sv https://pay.oclawbox.com 2>&1 | grep -E 'subject:|expire|issuer:'
```

TLS is provided by the cluster-wide wildcard cert `*.oclawbox.com` (Let's Encrypt via cert-manager).

## Secrets Inventory

| Secret | Namespace | Keys | Used By |
|--------|-----------|------|---------|
| `crypto-payments-secret` | `default` | `WALLET_BASE`, `WALLET_ETH`, `WALLET_TON`, `WALLET_SOL`, `API_KEY`, `CALLBACK_SECRET`, `RPC_*` (optional) | CryptoPayments |
| `openclaw-bot-secret` | `default` | `TELEGRAM_BOT_TOKEN` (+ existing keys) | Both services |

## Updating / Redeploying

```bash
# Build and push new image
docker build -t ghcr.io/vibetechnologies/crypto-payments:latest .
docker push ghcr.io/vibetechnologies/crypto-payments:latest

# Restart deployment to pull latest
kubectl rollout restart deployment/crypto-payments
kubectl rollout status deployment/crypto-payments --timeout=120s

# Verify
curl -s https://pay.oclawbox.com/api/health
```

## Running Tests

### CryptoPayments (48 tests)

```bash
cd /path/to/CryptoPayments
pnpm test
```

### OpenClawBot Crypto Webhook Tests

```bash
cd /path/to/OpenClawBot
pnpm test tests/crypto-webhook.test.ts
```
