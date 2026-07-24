# testnet/ — Ethereum Sepolia test assets & helpers

Funded wallets and scripts for exercising the crypto-payments flow on **Ethereum Sepolia**.

## Assets

| File | What |
|---|---|
| `wallet-1.json` | Funded test wallet (`0x64cd33D639Cbb0b461c64ec989a7d9789d701a30`) — holds aUSD + Sepolia ETH for gas. `*.png` is its QR. |
| `ownerkey.json` | aUSD owner/minter key. |
| `testwallet.ts` | Generate a new `wallet-N.json` (+ QR). Run: `bun testnet/testwallet.ts`. |
| `send-ausd.ts` | Send aUSD from a wallet file (below). |

**agentUSD (aUSD):** ERC-20, **6 decimals**, contract `0xfCCfda616e5107AC579712C5A461397f88e8e3f2`.
Payments recipient (eth_sepolia) is read live from the edge fn `/api/config`.

## send-ausd.ts

Send aUSD on Sepolia from a testnet wallet.

```bash
# from repo root
pnpm tsx testnet/send-ausd.ts <to> <amount> [--wallet testnet/wallet-2.json]

# examples
pnpm tsx testnet/send-ausd.ts 0x9945ba0a781200b90b4c28528cced309abb90871 100
pnpm tsx testnet/send-ausd.ts 0xRecipient 5 --wallet testnet/wallet-2.json
```

- `<amount>` is a human aUSD value (`100`, `5.5`); scaled by 6 decimals.
- Defaults to `wallet-1.json` (resolved relative to the script).
- Checks the sender balance, broadcasts the `transfer`, waits for the receipt, and prints the
  tx hash, status, recipient balance, and an Etherscan link.

Env overrides: `AUSD_ADDRESS`, `SEPOLIA_RPC`.

> Testnet only. Never put a mainnet key in these files.
