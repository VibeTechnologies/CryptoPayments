# GSD Debug Knowledge Base

Resolved debug sessions. Used by `gsd-debugger` to surface known-pattern hypotheses at the start of new investigations.

---

## coinbase-no-valid-asset — Coinbase Wallet mobile shows "no valid asset found" when scanning the AppKit QR
- **Date:** 2026-06-30
- **Error patterns:** no valid asset found, coinbase wallet, coinbasePreference, smart wallet, walletlink, WalletConnect QR, metadata.url, appkit, eoaOnly, domain mismatch, pay.oclawbox.com, pay.agentlabs.cc
- **Root cause:** `coinbasePreference: "all"` made AppKit's Coinbase connector call `makeWeb3Provider({ options: "all" })`; with no injected extension (mobile/QR) the popup `CoinbaseWalletProvider` routes through the Coinbase Smart Wallet (SCW) path via keys.coinbase.com, and the Coinbase Wallet mobile app responds to that SCW handshake for a plain EOA payment dApp with "no valid asset found". Compounded by `metadata.url`/`icons` hardcoded to `pay.oclawbox.com` (≠ real origin `pay.agentlabs.cc`), breaking WalletConnect/Coinbase domain verification + app logo. Confirmed in @coinbase/wallet-sdk (`sign/util.js` fetchSignerType/createSigner, `util/provider.js` getCoinbaseInjectedProvider, `validatePreferences.js`) and @reown/appkit-utils `ethers/CoinbaseProvider.js`. Eliminated: token/asset addresses in handshake (only numeric appChainIds are sent).
- **Fix:** Set `coinbasePreference: "eoaOnly"` (forces WalletLink mobile-QR EOA connect; desktop extension unaffected). Make `metadata.url` dynamic = `process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin ?? "https://pay.agentlabs.cc"`, and `metadata.icons = [`${appUrl}/icon.png`]`. Documented `NEXT_PUBLIC_APP_URL` in `.env.example`. Added 4 regression tests in appkit.test.ts. (commit c649f74, PR #37)
- **Files changed:** web/src/lib/wallets/appkit.ts, web/.env.example, web/src/__tests__/lib/appkit.test.ts
---
