# How We Built a Crypto Payment System Without Third-Party Processors — Direct On-Chain Verification with Node.js

*Accept USDT and USDC on Base, Ethereum, TON, and Solana — no Stripe, no Coinbase Commerce, no middlemen. Just your wallet, an RPC node, and 500 lines of TypeScript.*

---

## Why We Ditched Payment Processors

Every crypto payment processor takes a cut. Coinbase Commerce charges 1%. BitPay charges 1-2%. MoonPay charges 1-4.5%. For a SaaS product where subscription amounts are $10-$100, those percentages add up — and they add a dependency on a third-party service that can freeze your funds, require KYC paperwork, or shut down your merchant account without notice.

We wanted something different for [OpenClaw](https://github.com/openclaw/openclaw), our AI-powered Telegram bot platform:

- **Zero fees** — user sends stablecoins directly to our wallet
- **No middlemen** — no merchant account, no payment processor dashboard
- **Multi-chain** — Base, Ethereum, TON, and Solana from day one
- **Self-hosted** — runs on our own infrastructure, fully open source
- **Instant verification** — read the blockchain directly via RPC

The result is [CryptoPayments](https://github.com/VibeTechnologies/CryptoPayments) — a self-hosted payment verification service that reads on-chain transaction receipts and activates subscriptions via webhook callbacks. No custody, no fees, no third parties.

This article walks through the system design, the on-chain verification logic, and the webhook integration pattern — with real code from our production system.

---

## System Architecture

Here's the high-level flow:

```
┌─────────────┐     ┌──────────────────┐     ┌────────────────┐
│  Telegram    │     │  CryptoPayments  │     │   Blockchain   │
│  Mini App    │────▶│  Service         │────▶│   RPC Node     │
│  (Frontend)  │     │  (Hono + SQLite) │     │   (viem/fetch) │
└─────────────┘     └──────┬───────────┘     └────────────────┘
                           │
                    Webhook (HMAC-signed)
                           │
                    ┌──────▼───────────┐
                    │  Your Backend    │
                    │  (OpenClawBot)   │
                    │  Activates sub   │
                    └──────────────────┘
```

**Three components, zero payment processors:**

1. **Payment Page** — A Telegram Mini App (or standalone web page) that shows the user which wallet address to send stablecoins to, and collects the transaction hash after they pay.

2. **Verification Service** — A Node.js server (Hono framework) that takes the transaction hash, queries the blockchain RPC node, parses ERC-20/SPL/Jetton transfer events, and confirms the payment went to our wallet for the correct amount.

3. **Webhook Callback** — Once verified, the service sends an HMAC-SHA256 signed webhook to the backend, which activates the user's subscription.

The user never sends crypto *to* our service. They send it directly to our wallet on-chain, then paste the transaction hash. We just *read* the blockchain to verify it happened.

---

## The Verification Engine: Reading the Blockchain Directly

This is the core innovation. Instead of relying on a payment processor to tell us "payment received," we read the blockchain transaction receipt ourselves.

### EVM Chains (Base & Ethereum)

For EVM chains, we use [viem](https://viem.sh/) to fetch the transaction receipt and scan for ERC-20 `Transfer` events:

```typescript
// src/verify.ts — CryptoPayments service
import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";
import { base, mainnet } from "viem/chains";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

export async function verifyEvmTransfer(
  txHash: string,
  chainId: "base" | "eth",
  config: Config,
): Promise<VerifiedTransfer | null> {
  const chain = chainId === "base" ? base : mainnet;
  const rpcUrl = chainId === "base" ? config.rpc.base : config.rpc.eth;
  const recipientWallet = config.wallets[chainId].toLowerCase();

  const client = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  const receipt = await client.getTransactionReceipt({
    hash: txHash as `0x${string}`,
  });

  if (!receipt || receipt.status === "reverted") return null;

  // Scan logs for ERC-20 Transfer events to our wallet
  for (const log of receipt.logs) {
    const contractAddress = log.address.toLowerCase();

    // Is this from a known stablecoin contract?
    let token: "usdt" | "usdc" | null = null;
    if (contractAddress === TOKEN_ADDRESSES[chainId].usdt.toLowerCase())
      token = "usdt";
    else if (contractAddress === TOKEN_ADDRESSES[chainId].usdc.toLowerCase())
      token = "usdc";
    else continue;

    // Decode Transfer event: topics[1]=from, topics[2]=to, data=value
    const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
    if (to !== recipientWallet) continue;

    const value = BigInt(log.data);
    const amountUsd = Number(formatUnits(value, 6)); // 6 decimals

    return {
      from: "0x" + log.topics[1].slice(26),
      to,
      amountRaw: value.toString(),
      amountUsd,
      token,
      blockNumber: Number(receipt.blockNumber),
      txHash,
    };
  }

  return null;
}
```

**What's happening:**

1. We create a `PublicClient` that connects to a public RPC endpoint (like `https://mainnet.base.org`). No API key needed for basic read operations.
2. We call `getTransactionReceipt` — this returns the finalized transaction result including all event logs.
3. We scan the logs for `Transfer(address,address,uint256)` events emitted by known stablecoin contracts (USDT and USDC).
4. We check the `to` address matches our wallet and extract the USD amount (both USDT and USDC use 6 decimal places).

That's it. No webhook from a payment processor. No polling an API. Just one RPC call to read the blockchain directly.

### Solana

Solana uses SPL Token transfers instead of ERC-20. The verification logic uses Solana's JSON-RPC `getTransaction` with `jsonParsed` encoding:

```typescript
export async function verifySolTransfer(
  txHash: string,
  config: Config,
): Promise<VerifiedTransfer | null> {
  const resp = await fetch(config.rpc.sol, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [txHash, {
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      }],
    }),
  });

  const { result: tx } = await resp.json();
  if (!tx || tx.meta?.err) return null;

  // Scan parsed instructions for SPL Token transfers
  const allInstructions = [
    ...(tx.transaction?.message?.instructions ?? []),
    ...(tx.meta?.innerInstructions?.flatMap(ii => ii.instructions) ?? []),
  ];

  for (const ix of allInstructions) {
    if (ix.program !== "spl-token") continue;
    if (ix.parsed?.type !== "transfer" && ix.parsed?.type !== "transferChecked")
      continue;

    // Match destination ATA owner against our wallet
    const destOwner = findOwnerForAccount(
      tx.meta.postTokenBalances,
      tx.transaction.message.accountKeys.map(k => k.pubkey),
      ix.parsed.info.destination
    );
    if (destOwner !== config.wallets.sol) continue;

    // Check mint matches USDT or USDC
    // ... extract amount and return VerifiedTransfer
  }
  return null;
}
```

**Key Solana detail:** On Solana, users send tokens to an Associated Token Account (ATA), not your wallet address directly. We use `postTokenBalances` from the transaction metadata to resolve which wallet owns the destination ATA.

### TON

TON uses Jetton transfers. We query the TonCenter v3 API's `/jetton/transfers` endpoint:

```typescript
export async function verifyTonTransfer(
  txHash: string,
  config: Config,
): Promise<VerifiedTransfer | null> {
  const apiBase = config.rpc.ton.replace(/\/+$/, "");
  const url = `${apiBase}/jetton/transfers?transaction_hash=${
    encodeURIComponent(txHash)
  }&limit=10`;

  const resp = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  const { jetton_transfers } = await resp.json();

  for (const transfer of jetton_transfers ?? []) {
    // Match jetton_master against known USDT/USDC master contracts
    // Check destination matches our wallet
    // Extract amount (6 decimals)
  }
  return null;
}
```

### Unified Dispatch

A single `verifyTransfer` function routes to the right chain-specific verifier:

```typescript
export async function verifyTransfer(
  txHash: string,
  chainId: ChainId,
  config: Config,
): Promise<VerifiedTransfer | null> {
  switch (chainId) {
    case "base":
    case "eth":  return verifyEvmTransfer(txHash, chainId, config);
    case "ton":  return verifyTonTransfer(txHash, config);
    case "sol":  return verifySolTransfer(txHash, config);
  }
}
```

---

## Stablecoin Contract Addresses

One of the details you need to get right is the contract addresses for USDT and USDC on each chain. Here are the mainnet addresses we use:

```typescript
// src/config.ts
export const TOKEN_ADDRESSES = {
  base: {
    usdt: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  eth: {
    usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  ton: {
    usdt: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",
    usdc: "EQCxlMUk0_5_TABhCHdXqHEVjYpOCnFBkKpKGRpMpech0diD",
  },
  sol: {
    usdt: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
};
```

These are the canonical stablecoin contracts. The verification logic checks that the ERC-20/SPL/Jetton `Transfer` event was emitted by one of these contracts — preventing someone from creating a fake "USDC" token and sending it to your wallet.

---

## Plan Matching with Tolerance

Users don't always send exactly $10.00 or $25.00. Gas fees, exchange rates, and rounding can cause small discrepancies. We match amounts to plans with a 1% tolerance:

```typescript
export function resolveplan(
  amountUsd: number,
  prices: Config["prices"],
): string | null {
  const tolerance = 0.01; // 1%
  if (Math.abs(amountUsd - prices.max) / prices.max <= tolerance) return "max";
  if (Math.abs(amountUsd - prices.pro) / prices.pro <= tolerance) return "pro";
  if (Math.abs(amountUsd - prices.starter) / prices.starter <= tolerance)
    return "starter";
  return null;
}
```

So $9.95 matches the Starter plan ($10), $24.80 matches Pro ($25), and $99.50 matches Max ($100). This small detail makes a big difference in UX — nobody wants their payment rejected because gas consumed 0.05 USDC from their transfer amount.

---

## The Webhook Contract: Connecting to Your Backend

Once a payment is verified, the CryptoPayments service sends a webhook to your backend. This is where the "payment processor replacement" story comes together.

### Outbound (CryptoPayments sends)

```typescript
// src/server.ts — sendCallback()
async function sendCallback(callbackUrl: string, payment: Payment) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = JSON.stringify({
    event: "payment.verified",
    payment: {
      id: payment.id,
      idType: payment.id_type,
      uid: payment.uid,
      plan: payment.plan_id,
      chain: payment.chain_id,
      token: payment.token,
      amountUsd: payment.amount_usd,
      txHash: payment.tx_hash,
    },
    timestamp,
  });

  const signature = createHmac("sha256", config.callbackSecret)
    .update(payload)
    .digest("hex");

  await fetch(callbackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature": signature,    // HMAC-SHA256 hex digest
      "X-Timestamp": timestamp,    // Unix seconds
    },
    body: payload,
  });
}
```

### Inbound (Your backend receives)

On the receiving side (our Telegram bot), we verify the HMAC signature, check the timestamp to prevent replay attacks, and activate the subscription:

```typescript
// OpenClawBot — src/payments/crypto-webhook.ts
export function verifyCryptoSignature(
  secret: string,
  rawBody: string,
  signature: string,
): boolean {
  const expected = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  // Constant-time comparison to prevent timing attacks
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}
```

The webhook handler follows a "200-then-process" pattern — we respond `200 OK` immediately so the sender doesn't retry, then process the payment asynchronously:

```typescript
// Respond 200 immediately
res.writeHead(200);
res.end("OK");

// Process asynchronously
try {
  await processPaymentVerified(deps, payload);
} catch (err) {
  log.error("Error processing crypto webhook", { error: err.message });
}
```

**Security checklist for the webhook:**
- HMAC-SHA256 signature verification (shared secret)
- Timestamp validation (reject if > 5 minutes old)
- Rate limiting (60 requests/minute per IP)
- Request body size limit (64 KB)
- Idempotency check (tx hash is unique — don't process twice)
- Constant-time signature comparison (prevent timing attacks)

---

## The Payment Page: Telegram Mini App

The payment page is a self-contained HTML page served directly from the Hono server. It integrates with the Telegram Mini App SDK:

```
GET / → Serves the payment page HTML
```

The page flow:
1. User selects chain (Base, Ethereum, Solana, TON) and token (USDC/USDT)
2. Page displays the wallet address and exact amount to send
3. User sends crypto from their wallet app
4. User pastes the transaction hash
5. Page calls `POST /api/payment` with the tx hash
6. Server verifies on-chain and sends webhook to the bot backend
7. Bot activates subscription and notifies the user in Telegram

No external payment widget. No redirect to a third-party checkout page. The entire flow happens inside Telegram.

---

## Infrastructure: Self-Hosted on Kubernetes

We deploy CryptoPayments to the same AKS (Azure Kubernetes Service) cluster as our main bot. The Kubernetes manifests are in the repo:

```
k8s/
  deployment.yaml   # Single replica, 128Mi-256Mi memory
  service.yaml      # ClusterIP on port 3003
  ingress.yaml      # Traefik IngressRoute → pay.yourdomain.com
  pvc.yaml          # 1Gi PVC for SQLite database
  kustomization.yaml
```

The Docker image is a minimal `node:22-slim` multi-stage build:

```dockerfile
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
CMD ["node", "dist/server.js"]
```

**Total resource footprint:** ~128 MB RAM, negligible CPU. This runs alongside your main application for essentially free on any existing cluster.

---

## What About Security?

Fair question. When you're handling real money, here's what matters:

**1. We never touch user funds.** Users send stablecoins directly to our wallet using their own wallet app (MetaMask, Phantom, Tonkeeper, etc.). The CryptoPayments service only *reads* the blockchain — it has no private keys, no custody, no ability to move funds.

**2. Transaction verification is trustless.** We read the transaction receipt from a public RPC node. The blockchain is the source of truth. If the ERC-20 `Transfer` event exists in the finalized receipt with the correct `to` address and amount, the payment happened. Period.

**3. Contract address whitelisting.** We only accept transfers from known stablecoin contracts (USDT and USDC on each chain). Someone can't create a worthless token called "USDC" and trick the verifier.

**4. Webhook signatures.** The callback from CryptoPayments to your backend uses HMAC-SHA256 with a shared secret. Without the secret, an attacker can't forge a "payment verified" webhook.

**5. Replay protection.** Timestamps in webhook callbacks are validated (5-minute window). Transaction hashes are stored with uniqueness constraints — the same tx can't activate two subscriptions.

---

## The Economics

Let's do the math for a SaaS with 1,000 monthly subscribers on the $10/month plan:

| Approach | Monthly Revenue | Fees | You Keep |
|---|---|---|---|
| Stripe | $10,000 | $320 (2.9% + 30c) | $9,680 |
| Coinbase Commerce | $10,000 | $100 (1%) | $9,900 |
| CryptoPayments (self-hosted) | $10,000 | ~$2 (RPC costs) | **$9,998** |

The "fees" for self-hosted are just the RPC calls to verify transactions — and public RPC endpoints like `mainnet.base.org` are free for low-volume use. Even with a paid RPC provider like Alchemy, you're looking at pennies per verification.

On Base specifically, user gas fees are typically under $0.01 per transfer. Compare that to Stripe's 30-cent per-transaction minimum.

---

## Get Started

The complete source code is open source:

**[github.com/VibeTechnologies/CryptoPayments](https://github.com/VibeTechnologies/CryptoPayments)**

To run locally:

```bash
git clone https://github.com/VibeTechnologies/CryptoPayments.git
cd CryptoPayments
pnpm install

# Configure your wallets
cp .env.example .env
# Edit .env with your wallet addresses

pnpm dev
# Server running at http://localhost:3003
```

To deploy on Kubernetes:

```bash
# Create secrets
kubectl create secret generic crypto-payments-secret \
  --from-literal=WALLET_BASE=0xYourBaseWallet \
  --from-literal=WALLET_ETH=0xYourEthWallet \
  --from-literal=WALLET_SOL=YourSolanaWallet \
  --from-literal=WALLET_TON=YourTonWallet \
  --from-literal=CALLBACK_SECRET=your-hmac-secret \
  --from-literal=API_KEY=your-api-key

# Deploy
kubectl apply -k k8s/
```

The full system — verification engine, payment page, webhook callbacks, database, Kubernetes manifests — is under 1,500 lines of TypeScript. No external dependencies besides `viem` for EVM chain interaction and `hono` for the HTTP server.

---

## When NOT to Use This

To be clear, this approach isn't for everyone:

- **If you need fiat on-ramps** — users must already have crypto in a wallet
- **If you need chargebacks/disputes** — blockchain payments are irreversible
- **If you need tax reporting integration** — you'll need to build this yourself
- **If you're processing millions** — consider a proper treasury management solution
- **If compliance requires a licensed processor** — check your jurisdiction

For SaaS products, developer tools, and digital services where your users already have crypto wallets, this is the simplest and cheapest way to accept stablecoin payments.

---

## What's Next

We're actively developing:
- **Subscription renewals** — on-chain recurring payment detection
- **Multi-currency support** — beyond stablecoins (ETH, SOL native tokens)
- **Payment links** — shareable URLs with pre-filled amounts
- **Admin dashboard** — self-hosted payment analytics

Star the repo if this is useful: [github.com/VibeTechnologies/CryptoPayments](https://github.com/VibeTechnologies/CryptoPayments)

---

*Built by the [Vibe Technologies](https://github.com/VibeTechnologies) team. We build open-source developer tools and AI infrastructure.*

---

**Tags:** `crypto payments` `stablecoin` `USDT` `USDC` `Base` `Ethereum` `Solana` `TON` `Node.js` `TypeScript` `self-hosted` `no-code payments` `blockchain` `ERC-20` `SPL Token` `payment processor` `open source` `Telegram Mini App` `webhook` `HMAC` `viem`
