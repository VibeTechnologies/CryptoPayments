---
name: crypto-testnet-funds
description: Generate testnet wallets and move funds (agentUSD / Sepolia ETH) in the CryptoPayments repo. Use when you need to create a new test wallet, fund a wallet, send aUSD to an address, or set up an on-chain payment test on Ethereum Sepolia.
---

# Crypto testnet wallets & funds (CryptoPayments)

On-chain test ops for CryptoPayments on **Ethereum Sepolia**. Testnet only — never put a mainnet key in these files.

## Facts (verified)

- **agentUSD (aUSD):** ERC-20, **6 decimals**, contract `0x76B2AeC049e93FB53f210a4B0f02fe3Dee6514C3` (`src/config.ts` tokens.eth_sepolia.ausd).
- **RPC:** `https://ethereum-sepolia-rpc.publicnode.com` (override with `SEPOLIA_RPC`).
- **Funded wallet:** `testnet/wallet-1.json` = `0x64cd33D639Cbb0b461c64ec989a7d9789d701a30` (holds aUSD + Sepolia ETH for gas). Default sender for the send script.
- **Owner/minter key:** `testnet/ownerkey.json` — owns the aUSD contract (can mint).
- **Payments recipient** for a given chain is read live from the edge fn — `curl -s "$EDGE/api/config"` → `.wallets.eth_sepolia` (do NOT hardcode; it differs from the owner address).
- Package manager: run TS via `pnpm tsx <file>`; `testwallet.ts` uses `bun`.

Wallet JSON shape: `{ index, address, publicKey, privateKey, mnemonic, qrPayload }`.

## Generate a new wallet

```bash
cd testnet && bun testwallet.ts      # writes testnet/wallet-<N>.json (+ wallet-<N>.png QR), auto-incremented N
```

A fresh wallet has **0 ETH and 0 aUSD** — fund it before use (below).

## Send aUSD

```bash
# from repo root. <amount> is human aUSD (e.g. 100, 5.5); scaled by 6 decimals.
pnpm tsx testnet/send-ausd.ts <to> <amount> [--wallet testnet/wallet-2.json]

# example: 100 aUSD from wallet-1 (default) to an address
pnpm tsx testnet/send-ausd.ts 0x9945ba0a781200b90b4c28528cced309abb90871 100
```

Prints sender balance, tx hash, receipt status, recipient balance, and an Etherscan link. Exits non-zero on failure or insufficient balance. Env overrides: `AUSD_ADDRESS`, `SEPOLIA_RPC`. See `testnet/README.md`.

## Fund a fresh wallet

1. **aUSD** — send from `wallet-1` (it's funded): `pnpm tsx testnet/send-ausd.ts <new-addr> <amount>`.
2. **Sepolia ETH (gas)** — `wallet-1` has gas; move some with cast or a public Sepolia faucet:
   ```bash
   ~/.foundry/bin/cast send <new-addr> --value 0.01ether \
     --rpc-url https://ethereum-sepolia-rpc.publicnode.com \
     --private-key "$(python3 -c "import json;print(json.load(open('testnet/wallet-1.json'))['privateKey'])")"
   ```

## Mint aUSD / deploy (owner ops)

Minting new aUSD and (re)deploying the token use `testnet/ownerkey.json`. The mint signature and deploy steps live in **`docs/DEPLOY-eth-sepolia-topup.md`** — read it before minting; do not guess the contract ABI. Default to moving existing aUSD from `wallet-1` instead of minting unless you specifically need new supply.

## Check balances

```bash
~/.foundry/bin/cast call 0x76B2AeC049e93FB53f210a4B0f02fe3Dee6514C3 \
  "balanceOf(address)(uint256)" <addr> \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com   # raw, /1e6 = aUSD
~/.foundry/bin/cast balance <addr> --rpc-url https://ethereum-sepolia-rpc.publicnode.com  # ETH (wei)
```

## Stop rules

- Verify the recipient address character-for-character before sending — transfers are irreversible.
- Confirm the sender wallet has enough aUSD AND ETH gas first (the send script checks aUSD, not gas).
- Testnet keys only. Never commit a key you didn't generate here; never reuse these on mainnet.
