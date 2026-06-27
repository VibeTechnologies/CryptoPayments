# AgentUSD Deployments

## Anvil Local Testnet

- **Contract:** 0x5FbDB2315678afecb367f032d93F642f64180aa3
- **Network:** Anvil localhost:8546 (chain-id 84532 = base_sepolia emulation)
- **Deployer:** 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (Anvil account #0)
- **Date:** 2026-06-26
- **Minted:** 10,000 aUSD to deployer + 5 aUSD transferred to test wallet (0x70997970C51812dc3A010C7d01b50e0d17dc79C8)

This deployment is ephemeral (Anvil restarts wipe state). Re-run `tests/e2e-agentUSD-topup.sh` to redeploy.

---

## Base Sepolia (testnet)

- **Contract address:** pending — no funded key available
- **Owner/deployer wallet:** pending

### Network Details
- **Chain ID:** 84532
- **RPC:** https://sepolia.base.org

### Simulation Result
- Estimated gas: 1,586,344 units
- Estimated cost: ~0.0000174 ETH at 0.011 gwei

### To Deploy
Provide a funded Base Sepolia wallet private key, then run:

```bash
cd /Users/engineer/workspace/CryptoPayments/contracts/agentUSD
~/.foundry/bin/forge script script/DeployAgentUSD.s.sol \
  --rpc-url https://sepolia.base.org \
  --private-key $PRIVATE_KEY \
  --broadcast
```

Get free Base Sepolia ETH at: https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet

After deploy the script mints 10,000 aUSD (10_000 × 10^6 units) to the deployer.
