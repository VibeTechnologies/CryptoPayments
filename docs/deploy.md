# Deployment Guide

## Architecture

```
Telegram Mini App (pay.oclawbox.com)
        ↓ HTTPS (JSON)
Supabase Edge Function (API)
        ↓ on-chain verify
Blockchain RPCs (Base, ETH, TON, SOL)
        ↓ webhook POST
OpenClawBot (console.oclawbox.com/crypto/webhook)
```

- **Frontend**: Next.js static export SPA hosted on Azure Static Web Apps
- **API**: Supabase Edge Function (`crypto-payments`)
- **Database**: Supabase Postgres

## Frontend (Azure Static Web Apps)

### Production URLs

| URL | Description |
|-----|-------------|
| `https://pay.oclawbox.com` | Custom domain (production) |
| `https://victorious-pebble-0dd69340f.4.azurestaticapps.net` | Default Azure SWA hostname |

### Azure Resources

- **SWA resource**: `cryptopayments-spa`
- **Resource group**: `openclaw-aks`
- **Region**: East US 2
- **GitHub secret**: `AZURE_SWA_PAY_TOKEN` (deployment token)

### DNS Configuration

CNAME record in Azure DNS zone `oclawbox.com`:

```
pay.oclawbox.com → victorious-pebble-0dd69340f.4.azurestaticapps.net
```

Azure SWA handles TLS automatically for custom domains.

### CI/CD

Workflow: `.github/workflows/pay-deploy.yml`

- **Triggers**: Push to `main` when files in `web/` change; PR preview deploys on PRs
- **Build**: `pnpm install && pnpm build` in `web/` directory
- **Deploy**: Copies `staticwebapp.config.json` into `web/out/`, then uploads via `Azure/static-web-apps-deploy@v1`

### Manual Redeploy

Push any change to `web/` on `main`, or re-run the workflow:

```bash
gh workflow run pay-deploy.yml --repo VibeTechnologies/CryptoPayments
```

### SWA Configuration

`web/staticwebapp.config.json` handles:
- SPA fallback routing (all paths serve `index.html`)
- Security headers (CSP, HSTS, X-Frame-Options allowing Telegram embedding)
- Cache control for static assets

## API (Supabase Edge Function)

### Production URL

```
https://wxxnkncwneyhmudfyayd.supabase.co/functions/v1/crypto-payments
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Wallet addresses, token contracts, supported chains, plan prices |
| POST | `/api/payment` | Submit tx hash for on-chain verification |
| GET | `/api/payment/:id` | Check payment status |
| POST | `/v1/checkout/sessions` | Create checkout session (Stripe-like) |

### Deploy Edge Function

```bash
supabase functions deploy crypto-payments --project-ref wxxnkncwneyhmudfyayd
```

### Environment Variables (Edge Function)

Set via Supabase dashboard or CLI:

- `SUPABASE_URL` — Auto-set by Supabase
- `SUPABASE_ANON_KEY` — Auto-set by Supabase
- `CRYPTO_CALLBACK_SECRET` — HMAC secret for webhook signatures
- `CRYPTO_PAYMENTS_API_KEY` — API key for authenticated requests

## OpenClawBot Integration

The bot constructs payment URLs using `CRYPTO_PAYMENTS_URL`:

```
${CRYPTO_PAYMENTS_URL}/pay?plan=${planId}&uid=${telegramUserId}&callback=${callbackUrl}
```

### Bot Environment Variables

| Variable | Value | Description |
|----------|-------|-------------|
| `CRYPTO_PAYMENTS_ENABLED` | `true` | Enable crypto payment option |
| `CRYPTO_PAYMENTS_URL` | `https://pay.oclawbox.com` | SPA base URL |
| `CRYPTO_PAYMENTS_API_KEY` | (secret) | API key for backend calls |
| `CRYPTO_CALLBACK_SECRET` | (secret) | HMAC-SHA256 webhook signature key |
| `CRYPTO_CALLBACK_URL` | `https://console.oclawbox.com/crypto/webhook` | Webhook endpoint |

### Webhook Contract

CryptoPayments → OpenClawBot `POST` with `X-Signature` header (HMAC-SHA256):

```json
{
  "event": "payment.verified",
  "payment": {
    "id": "uuid",
    "idType": "telegram",
    "uid": "123456",
    "plan": "starter",
    "chain": "base",
    "token": "usdc",
    "amountUsd": 10,
    "txHash": "0x..."
  },
  "timestamp": "2026-02-16T..."
}
```

## Supported Chains and Tokens

| Chain | Token | Contract |
|-------|-------|----------|
| Base | USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Base | USDT | `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` |
| Ethereum | USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Ethereum | USDT | `0xdAC17F958D2ee523a2206206994597C13D831ec7` |
| TON | USDC | `EQCxlMUk0_5_TABhCHdXqHEVjYpOCnFBkKpKGRpMpech0diD` |
| TON | USDT | `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs` |
| Solana | USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Solana | USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| Base Sepolia (testnet) | USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

Receiving wallet: `0x22Cdc7925ffAb409EbCA5ab8c912Fcd8E2644acD` (EVM), `UQDQx44DMgyzrR0XFgdX6XWFeAiVKiCZzLd4-pBeotG4xeE7` (TON), `3z6XF6mRAoT59mgLFwQTUmWdjeC6r5ttJr3AYv7Mootc` (SOL)

## Adding a New Custom Domain

1. Create CNAME record in Azure DNS:
   ```bash
   az network dns record-set cname set-record \
     --resource-group openclaw-aks \
     --zone-name oclawbox.com \
     --record-set-name newdomain \
     --cname victorious-pebble-0dd69340f.4.azurestaticapps.net
   ```

2. Register domain on SWA:
   ```bash
   az staticwebapp hostname set \
     --name cryptopayments-spa \
     --resource-group openclaw-aks \
     --hostname newdomain.oclawbox.com
   ```

3. Wait for domain validation (check status):
   ```bash
   az staticwebapp hostname list \
     --name cryptopayments-spa \
     --resource-group openclaw-aks -o table
   ```
