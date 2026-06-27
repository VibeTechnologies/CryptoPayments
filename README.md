# CryptoPayments
Crypto payment processor - accepts USDT/USDC on Base, Ethereum, TON, and Solana. Records payments linked to Telegram user IDs or email.

## Deploy to Vercel

This repo includes a shareable one-click deploy template for the pay page (`web/` — Next.js 16 static export).

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FVibeTechnologies%2FCryptoPayments&root-directory=web&env=NEXT_PUBLIC_API_URL&envDescription=Base%20URL%20of%20the%20crypto-payments%20edge%20function&envLink=https%3A%2F%2Fgithub.com%2FVibeTechnologies%2FCryptoPayments%2Fblob%2Fmain%2Fweb%2F.env.example&project-name=cryptopayments-pay&repository-name=cryptopayments-pay)

**What this deploys:** the crypto top-up pay page — a Next.js static site that lets users deposit USDT/USDC on Base, Ethereum, TON, or Solana and links payments to a Telegram user ID or email.

**Required environment variable:**

| Variable | Description | Default |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | Base URL of the crypto-payments Supabase Edge Function | `https://krjbwbvmrpazdmmjstzo.supabase.co/functions/v1/crypto-payments` |

The Deploy Button URL already presets `root-directory=web` and prompts for `NEXT_PUBLIC_API_URL` — Vercel will ask you to fill it in before deploying. See [`web/.env.example`](web/.env.example) for the default value and description.

> **Public Vercel Templates gallery:** submitting this to [vercel.com/templates](https://vercel.com/templates) is a separate manual step. The Deploy Button above is the self-serve shareable template — anyone with the link can one-click deploy their own copy.
