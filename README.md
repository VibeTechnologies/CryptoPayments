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

## Multi-product support

The service settles payments for more than one product (OpenClawBot, vibebrowser, ...).
A payment carries a `product` field; **absent means `openclaw`**, which is exactly
the pre-multi-product behaviour, so every intent already signed by OpenClawBot
keeps working unchanged.

### `product` is inside the checkout-intent signature

`product` selects the price table, the receiving wallet and the callback
allowlist. If it sat outside the HMAC, an attacker could sign an intent for the
cheap product and swap it to the expensive one before submitting — the same
class of bug as the unsigned `deploymentType` in OpenClawBot#3583.

The canonical string is unchanged for legacy callers: it is still the sorted
`key=value` lines joined by `\n`, and `product` is only appended **when
present**. A legacy intent therefore produces a byte-identical canonical string.

```
# legacy (no product) — unchanged
amountUsd=10.00
callback=https://admin.openclaw.agentlabs.cc/crypto/webhook
exp=1767225600
hostType=vps
idtype=tg
plan=starter
uid=42

# multi-product
amountUsd=12.00
callback=https://admin.openclaw.agentlabs.cc/crypto/webhook
exp=1767225600
hostType=vps
idtype=tg
plan=starter
product=vibe
uid=42
```

### Configuration

`PRODUCTS` lists the product ids (default `openclaw`). `openclaw` is always
present even if omitted. Per-product overrides use the product id, uppercased,
as an env-var suffix; anything not overridden falls back to the existing flat
env var, so a product with no overrides shares OpenClaw's prices and wallets
(a shared receiving wallet remains possible).

| Variable | Scope | Default |
|---|---|---|
| `PRODUCTS` | service | `openclaw` |
| `PRICE_STARTER` / `PRICE_PRO` / `PRICE_MAX` | default plan set | `10` / `25` / `100` |
| `PLANS_<PRODUCT>` | per product | *(unset — inherit the flat plan set)* |
| `PRICE_<PLAN>_<PRODUCT>` | per product | flat `PRICE_<PLAN>`, else **startup error** |
| `TOPUP_PRICE_SMALL` / `_MEDIUM` / `_LARGE` | default pack set | `5` / `10` / `25` |
| `TOPUPS_<PRODUCT>` | per product | *(unset — inherit the flat pack set)* |
| `TOPUP_PRICE_<PACK>_<PRODUCT>` | per product | flat `TOPUP_PRICE_<PACK>`, else **startup error** |
| `WALLET_BASE`, `WALLET_ETH`, ... | default product | — |
| `WALLET_BASE_<PRODUCT>`, ... | per product | the flat wallet above (logs a startup WARNING) |
| `CALLBACK_URL_ALLOWLIST` | default product | see `src/config.ts` |
| `CALLBACK_URL_ALLOWLIST_<PRODUCT>` | per product | the flat allowlist above |
| `PRODUCT_NAME_<PRODUCT>` | per product | the product id |
| `PRODUCT_ICON_<PRODUCT>` | per product | `https://openclaw.ai/favicon.ico` |

#### Per-product plan sets

A product's plan set is **open**: plan names are not fixed to
`starter`/`pro`/`max`. Declare a product's own set with `PLANS_<PRODUCT>` and
price each declared plan with `PRICE_<PLAN>_<PRODUCT>`:

```
PRODUCTS=openclaw,vibe
PLANS_VIBE=pro,max
PRICE_PRO_VIBE=20
PRICE_MAX_VIBE=99
```

A product that declares a plan set contains **exactly** that set — it does not
inherit plans it did not declare. Above, `vibe` has no `starter`, so a $10
payment on `vibe` resolves to *no plan* rather than to OpenClaw's `starter`.

This matters because plans are resolved from the on-chain USD amount. With the
old fixed `starter`/`pro`/`max` struct, every product inherited a `starter`
plan, a $10 `vibe` payment was credited as `plan:"starter"`, and the consumer
rejected it as `unknown_plan` — with no callback retry, so the payment settled
on-chain and nothing was ever delivered.

Omit `PLANS_<PRODUCT>` to keep the historical behaviour: the product inherits
the flat `PRICE_STARTER`/`PRICE_PRO`/`PRICE_MAX` set, individually overridable
per product. `TOPUPS_<PRODUCT>` works the same way for top-up packs.

#### Startup validation

`loadConfig()` **throws** rather than booting with a price table that could
misresolve a payment:

- a plan declared in `PLANS_<PRODUCT>` with no valid price;
- a non-positive or non-finite price;
- two plans in one product whose match bands overlap.

Bands overlap when two prices are closer than the larger of this service's
relative tolerance (1% of each price) and a downstream absolute tolerance
(±$1 each). Overlapping bands make amount-based plan resolution ambiguous — the
result depends on iteration order, and a consumer matching with its own
tolerance can disagree with us about the same payment. That disagreement is
unrecoverable (the consumer 400s and the callback is never retried), so it is
refused at boot. This repo intentionally does **not** encode any consumer's
prices; it only makes ambiguity impossible to configure silently.

#### Wallet inheritance

A product with no `WALLET_<CHAIN>_<PRODUCT>` still shares the global
`WALLET_<CHAIN>` (a shared receiving wallet stays supported), but every such
inheritance is now named in a startup `[CONFIG]` warning, so a deploy that
forgets `WALLET_BASE_VIBE` no longer silently routes vibe's revenue into
OpenClaw's wallet.

Example — add vibebrowser with its own prices and Base wallet:

```
PRODUCTS=openclaw,vibe
PRICE_STARTER_VIBE=12
PRICE_PRO_VIBE=30
PRICE_MAX_VIBE=120
WALLET_BASE_VIBE=0x...
PRODUCT_NAME_VIBE=Vibe Browser
CALLBACK_URL_ALLOWLIST_VIBE=api.vibebrowser.app
```

### API

- `POST /api/payment` accepts an optional `product`. An unknown id is a `400`
  (never silently coerced to `openclaw`).
- `GET /api/config?product=vibe` returns that product's wallets, prices,
  top-up prices and branding. Without the query param it returns `openclaw`'s,
  identical to before.
- `GET /tonconnect-manifest.json?product=vibe` brands the manifest per product.
- The webhook callback payload now always includes `payment.product`
  (defaulting to `openclaw`). All existing fields are unchanged.
- The pay SPA reads `?product=` from the URL and forwards it.
