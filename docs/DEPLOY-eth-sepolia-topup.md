# Deploy runbook — crypto topup fix + eth_sepolia/agentUSD

Ships the topup-callback fix and the supply-controlled testnet path (agentUSD on
Ethereum Sepolia) to prod, then proves it end-to-end.

## State (2026-06-26)
- CryptoPayments PR #29 (branch `feat/topup-callback-field`, commit `3f6cc63`) — code done, Anvil E2E PASS, OPEN.
- OpenClawBot PR #2417 (branch `fix/crypto-topup-litellm-userid`) — litellmUserId fallback so credits apply, OPEN.
- agentUSD live on Ethereum Sepolia: `0x76B2AeC049e93FB53f210a4B0f02fe3Dee6514C3` (6 dec, owner-only mint).
- Owner / payments recipient: `0xF08E2a9D128827615Fca921f278b7bFCBac895E2`.
- Test wallet (holds 10k aUSD): `0x64cd33D639Cbb0b461c64ec989a7d9789d701a30` (key: Bitwarden "agentUSD testnet wallet").

## Deploy targets (from recon)
- **CryptoPayments API** = Supabase Edge Function, project ref `krjbwbvmrpazdmmjstzo`, fronted by `pay.vibebrowser.app`. Deploy: `pnpm predeploy:edge && pnpm deploy:edge`.
- **DB migrations** = manual `supabase db push` to the same project (no CI path).
- **SPA** = Next.js static → Azure SWA via `.github/workflows/pay-deploy.yml` (auto on `web/**` to main).
- **OpenClawBot** = AKS (kubectl ctx `openclaw-aks`), CI deploys on merge to main. Webhook receiver `/crypto/webhook`, HMAC headers `X-Signature` + `X-Timestamp`, secret `CRYPTO_CALLBACK_SECRET`.

## BLOCKER: Supabase auth not on this machine
`supabase` CLI v2.75.0 installed but unauthenticated. Need ONE of:
- `supabase login` (interactive — run via `! supabase login`), or
- `export SUPABASE_ACCESS_TOKEN=<token>`
Plus the DB password for `supabase link --project-ref krjbwbvmrpazdmmjstzo`.

## Steps

1. **Merge PRs** (after CI green): `gh pr merge 29 --squash` (CryptoPayments), `gh pr merge 2417 --squash` (OpenClawBot).

2. **Auth + link Supabase**
   ```bash
   supabase login                 # or export SUPABASE_ACCESS_TOKEN=...
   cd /Users/engineer/workspace/CryptoPayments
   supabase link --project-ref krjbwbvmrpazdmmjstzo   # prompts DB password
   ```

3. **Migrate live DB** (widens chain_id/token CHECK to include eth_sepolia/ausd)
   ```bash
   supabase db push               # applies 20260626130000_add_eth_sepolia_ausd.sql
   ```
   Verify: insert with chain_id='eth_sepolia', token='ausd' must NOT be rejected.

4. **Set edge function secrets** (else eth_sepolia silently uses MAINNET WALLET_ETH)
   ```bash
   R=krjbwbvmrpazdmmjstzo
   supabase secrets set --project-ref $R \
     WALLET_ETH_SEPOLIA=0xF08E2a9D128827615Fca921f278b7bFCBac895E2 \
     RPC_ETH_SEPOLIA=https://ethereum-sepolia-rpc.publicnode.com \
     BASE_URL=https://pay.vibebrowser.app
   ```
   Confirm existing `CALLBACK_SECRET` == OpenClawBot `CRYPTO_CALLBACK_SECRET`, and `API_KEY` == bot `CRYPTO_PAYMENTS_API_KEY`.

5. **Redeploy edge function** (predeploy:edge refreshes the stale copied src/)
   ```bash
   pnpm predeploy:edge && pnpm deploy:edge   # or: npx pnpm@9 ...
   ```

6. **Confirm SPA deploy** — merging web/** to main triggers pay-deploy.yml. Check the Actions run green; open https://pay.vibebrowser.app/pay?uid=1&topup=small&test=true → Ethereum Sepolia 🧪 + aUSD selectable.

7. **Confirm OpenClawBot rollout** — `kubectl --context openclaw-aks -n <ns> rollout status deploy/openclaw-bot`.

8. **Cross-service REAL E2E (the R1 proof)**
   - Need a test tenant tg uid with active Pro/Max sub (topup gate requires litellmBudget>0).
   - a. Real aUSD transfer test wallet → owner on Sepolia (5 aUSD = "small" $5 → 5000000 units; confirm pack amount in config CREDIT_PACKS):
     ```bash
     cast send 0x76B2AeC049e93FB53f210a4B0f02fe3Dee6514C3 \
       "transfer(address,uint256)" \
       0xF08E2a9D128827615Fca921f278b7bFCBac895E2 5000000 \
       --private-key <test-wallet-key> \
       --rpc-url https://ethereum-sepolia-rpc.publicnode.com
     ```
   - b. Submit to prod:
     ```bash
     curl -X POST https://pay.vibebrowser.app/api/payment \
       -H 'Content-Type: application/json' \
       -d '{"txHash":"0x<from step a>","chainId":"eth_sepolia","token":"ausd","idType":"tg","uid":"<test-tg-id>","topup":"small","apiKey":"<API_KEY>","callbackUrl":"https://admin.openclaw.vibebrowser.app/crypto/webhook"}'
     ```
   - c. Assert: response status=verified, payment.topup_id=small; OpenClawBot logs the callback; the test user's LiteLLM budget increases (check /balance in @OpenClawBoxBot or GET /api/v1/billing). THIS is "done".
