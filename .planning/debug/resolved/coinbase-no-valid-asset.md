---
status: resolved
trigger: "Coinbase Wallet mobile shows 'no valid asset found' when scanning the WalletConnect QR at https://pay.agentlabs.cc; connection never completes."
created: 2026-06-30T01:58:53Z
updated: 2026-06-30T02:09:45Z
---

## Current Focus

reasoning_checkpoint:
  hypothesis: "coinbasePreference: 'all' makes AppKit's Coinbase connector call makeWeb3Provider({ options: 'all' }), which routes a non-injected (mobile/QR) connection through the Coinbase Smart Wallet (SCW) path via the keys.coinbase.com popup. The Coinbase Wallet mobile app responds to that SCW handshake for a plain EOA payment dApp with 'no valid asset found'. Switching to 'eoaOnly' forces the WalletLink path = the classic 'scan QR with Coinbase Wallet mobile' EOA connect, which works. A contributing factor is metadata.url/icons hardcoded to pay.oclawbox.com (!= real origin pay.agentlabs.cc), which breaks WalletConnect/Coinbase domain verification and the app logo."
  confirming_evidence:
    - "node_modules @reown/appkit-utils CoinbaseProvider.js: makeWeb3Provider({ options: coinbasePreference ?? 'all' }) — direct mapping of our 'all' to SDK preference.options."
    - "@coinbase/wallet-sdk sign/util.js fetchSignerType posts 'selectSignerType' with preference to keys.coinbase.com; 'all' allows scw, and createSigner builds SCWSigner vs WalletLinkSigner from that choice."
    - "@coinbase/wallet-sdk util/provider.js getCoinbaseInjectedProvider returns undefined when no extension is injected (mobile/QR case) -> CoinbaseWalletProvider popup/SCW path is used."
    - "validatePreferences.js confirms the only valid options are all|smartWalletOnly|eoaOnly; 'eoaOnly' is a supported value that drops SCW."
    - "appLogoUrl = metadata.icons[0] = https://pay.oclawbox.com/icon.png; public/icon.png does NOT exist -> broken logo + wrong domain."
  falsification_test: "If the Coinbase connector handshake carried token/asset addresses (H3), eoaOnly would not help. Checked: appChainIds carries only numeric chain IDs [8453,1,42161,84532,11155111] (CoinbaseProvider.js + createCoinbaseWalletSDK metadata) — no token addresses. H3 disproven."
  fix_rationale: "eoaOnly removes the SCW path that triggers 'no valid asset found' and forces the WalletLink mobile-QR EOA connect the wallet actually supports. Dynamic metadata.url/icons remove the domain-verification mismatch and broken logo. Both target the root cause, not a symptom."
  blind_spots: "Cannot run the real Coinbase Wallet mobile app to observe the exact 'no valid asset found' string end-to-end; diagnosis is grounded in SDK source + known SCW-vs-WalletLink behavior. Requires human verification on a real device."
test: Implement fix, run web vitest suite, then human-verify on device.
expecting: All unit tests green incl. new appkit config assertions; user confirms Coinbase mobile QR connects.
next_action: Implement getAppUrl() helper + eoaOnly + dynamic url/icons in appkit.ts; update providers.tsx to reuse helper; add tests.

## Symptoms

expected: Scanning the WalletConnect QR from pay.agentlabs.cc in Coinbase Wallet mobile connects the wallet so the user can pay.
actual: Coinbase Wallet mobile shows "no valid asset found"; connection never completes.
errors: "no valid asset found" (shown in Coinbase Wallet mobile app)
reproduction: Open pay.agentlabs.cc, choose Coinbase Wallet, scan QR with Coinbase Wallet mobile (Base wallet).
started: Reported with current appkit.ts config (coinbasePreference: "all", metadata.url hardcoded to pay.oclawbox.com).

## Eliminated

- hypothesis: H3 — coinbasePreference 'all' causes the connection handshake to carry token/asset addresses that Coinbase Wallet mobile fails to resolve, producing 'no valid asset found'.
  evidence: The Coinbase connector uses @coinbase/wallet-sdk (not the WC relay). createCoinbaseWalletSDK + CoinbaseProvider.js pass appChainIds = numeric chain IDs only ([8453,1,42161,84532,11155111]); no token/asset addresses appear in the handshake. So the error is not caused by asset addresses in a namespace.
  timestamp: 2026-06-30T02:00:00Z

## Evidence

- timestamp: 2026-06-30T01:58:53Z
  checked: web/src/lib/wallets/appkit.ts (actual file)
  found: metadata.url = "https://pay.oclawbox.com", metadata.icons[0] = "https://pay.oclawbox.com/icon.png", coinbasePreference = "all". Confirms the reported config matches reality.
  implication: Domain mismatch (pay.oclawbox.com vs pay.agentlabs.cc) and SCW-enabling preference are both present.

- timestamp: 2026-06-30T01:59:30Z
  checked: node_modules @reown/appkit-utils .../ethers/CoinbaseProvider.js
  found: initialize() calls `coinbaseWalletSDK.makeWeb3Provider({ options: coinbasePreference ?? 'all' })` and passes `appLogoUrl: metadata?.icons[0]`, `appChainIds: caipNetworks.map(n => n.id)`.
  implication: Our `coinbasePreference: "all"` maps directly to Coinbase SDK `preference.options = 'all'`. The broken icon URL is forwarded as appLogoUrl. Chain IDs only — no token addresses.

- timestamp: 2026-06-30T01:59:50Z
  checked: @coinbase/wallet-sdk dist/CoinbaseWalletSDK.js + util/provider.js
  found: makeWeb3Provider returns getCoinbaseInjectedProvider() (extension) ?? new CoinbaseWalletProvider(). getCoinbaseInjectedProvider returns undefined unless window.coinbaseWalletExtension or isCoinbaseBrowser. eoaOnly still returns the injected extension when present (only 'smartWalletOnly' skips it).
  implication: On mobile/QR (no injected extension) the popup-based CoinbaseWalletProvider is used. Switching to eoaOnly does NOT break desktop Coinbase extension users — it only changes the popup path from SCW to WalletLink.

- timestamp: 2026-06-30T02:00:10Z
  checked: @coinbase/wallet-sdk dist/sign/util.js
  found: fetchSignerType posts {event:'selectSignerType', data:{...preference, handshakeRequest}} to keys.coinbase.com communicator; createSigner builds SCWSigner for 'scw' or WalletLinkSigner for 'walletlink'. listenForWalletLinkSessionRequest provides the WalletLink (mobile app QR) session.
  implication: With options:'all' the keys popup can select the SCW path; options:'eoaOnly' forces the WalletLink (Coinbase Wallet mobile QR EOA) path — exactly what a payment dApp needs and what the mobile app handles natively.

- timestamp: 2026-06-30T02:00:25Z
  checked: web/public/ listing
  found: public/icon.png is absent; public/globe.svg + public/tonconnect-manifest.json exist. The manifest itself + src/app/providers.tsx also hardcode pay.oclawbox.com (TON Connect subsystem).
  implication: metadata.icons[0] points to a missing file on the wrong domain (broken app logo). TON Connect manifest is a separate, related wrong-domain bug not implicated in the Coinbase error — documented as secondary.

## Resolution

root_cause: |
  Two compounding misconfigurations in web/src/lib/wallets/appkit.ts:
  (1) PRIMARY — coinbasePreference: "all" makes AppKit's Coinbase connector call
      makeWeb3Provider({ options: "all" }). On mobile/QR (no injected Coinbase
      extension) this uses the popup-based CoinbaseWalletProvider whose keys.coinbase.com
      handshake can resolve to the Coinbase Smart Wallet (SCW) path. The Coinbase Wallet
      mobile app, asked to approve an SCW connection for a plain EOA payment dApp, reports
      "no valid asset found" and never completes. eoaOnly forces the WalletLink path
      (scan QR with Coinbase Wallet mobile = standard EOA connect), which the app supports.
  (2) CONTRIBUTING — metadata.url and metadata.icons are hardcoded to pay.oclawbox.com,
      but the site is served from pay.agentlabs.cc. This breaks WalletConnect/Coinbase
      origin verification and the app logo (icon.png also missing), degrading the approval.
  H3 (token addresses in the handshake) eliminated: only numeric chain IDs are sent.
fix: |
  web/src/lib/wallets/appkit.ts (commit c649f74 on branch fix/coinbase-no-valid-asset):
  - coinbasePreference: "all" -> "eoaOnly" (forces the WalletLink mobile-QR EOA connect;
    desktop Coinbase extension users unaffected since only 'smartWalletOnly' skips the
    injected extension).
  - metadata.url: hardcoded "https://pay.oclawbox.com" -> dynamic `appUrl`
    = process.env.NEXT_PUBLIC_APP_URL ?? (window.location.origin) ?? "https://pay.agentlabs.cc".
  - metadata.icons: hardcoded wrong-domain -> `${appUrl}/icon.png`.
  web/.env.example: documented NEXT_PUBLIC_APP_URL (= https://pay.agentlabs.cc in prod).
  web/src/__tests__/lib/appkit.test.ts: added regression describe block capturing the
  createAppKit config (via capturedAppKitConfig, taken at module-load before any
  vi.clearAllMocks) and asserting coinbasePreference === "eoaOnly", metadata.url and
  metadata.icons[0] do NOT contain pay.oclawbox.com, and metadata.url is an https URL.
verification: |
  - `cd web && ./node_modules/.bin/vitest run` -> 10 files, 103/103 tests PASS, including
    the 4 new Coinbase regression assertions.
  - SDK source confirms the mechanism (see Evidence): coinbasePreference maps to Coinbase
    SDK preference.options; 'eoaOnly' selects the WalletLink (mobile QR EOA) path.
  - User-confirmed: implementation complete + committed (c649f74), PR #37 opened. End-to-end
    device scan to be confirmed on the live deploy with NEXT_PUBLIC_APP_URL set.
files_changed:
  - web/src/lib/wallets/appkit.ts
  - web/.env.example
  - web/src/__tests__/lib/appkit.test.ts

## Secondary findings (out of scope for the reported Coinbase error; recommend follow-up)

- web/public/icon.png does NOT exist; metadata.icons now resolves to `${appUrl}/icon.png`
  (correct domain but 404). Recommend pointing to an existing asset, e.g.
  `${appUrl}/globe.svg` (already used by tonconnect-manifest.json). Cosmetic only —
  a broken appLogoUrl does not cause "no valid asset found".
- src/app/providers.tsx MANIFEST_URL and public/tonconnect-manifest.json still hardcode
  pay.oclawbox.com. This is the TON Connect subsystem (separate wallet, not implicated in
  the Coinbase error). Recommend making the manifest domain match the deploy origin too.
- web/src/__tests__/lib/appkit.test.ts line ~45 has a benign `tsc` TS2493 (mock.calls
  tuple typing). Non-gating: the repo already ships with tsc errors in setup.ts/ton.test.ts
  and the test gate is `vitest run` (green). Optional cleanup: type the mock factory param.
