/**
 * True end-to-end payment test — no mocked backend, no pre-sent tx.
 *
 * What this tests that e2e-telegram-topup.spec.ts does NOT:
 *   - sendEvmTransfer code path (real ethers.js contract.transfer())
 *   - The original bug: pending tx submitted to edge → must return 202, not error
 *   - Frontend polling loop ("Waiting for confirmation...")
 *   - GET /api/payment/:id lazy re-verification (backend fix tested live)
 *   - Final "Payment verified!" after chain confirmation
 *
 * Architecture:
 *   window.ethereum in browser → page.exposeFunction bridge → real viem walletClient
 *   All eth_* calls forwarded to Sepolia JSON-RPC.
 *   eth_sendTransaction intercepted → viem signs + broadcasts → returns hash IMMEDIATELY
 *   (no waitForTransactionReceipt in the bridge).
 *
 *   Result: ethers gets the hash while tx is PENDING → app submits to edge → 202 →
 *   spinner shown → app polls GET /api/payment/:id → edge re-verifies after mining →
 *   200 → "Payment verified!"
 *
 * Required env:
 *   CHECKOUT_SECRET  — HMAC signing secret (= OpenClawBot CRYPTO_CALLBACK_SECRET)
 *   testnet/wallet-1.json  — funded Sepolia test wallet
 */

import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient, createWalletClient, http,
  getAddress, type Hex, type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const EDGE_URL    = 'https://krjbwbvmrpazdmmjstzo.supabase.co/functions/v1/crypto-payments';
const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const AMOUNT_USD  = '5.00';
const TEST_UID    = '999777555';   // unique uid so no 409 collision with other tests
const TEST_TOPUP  = 'small';
const CALLBACK_URL = 'https://admin.openclaw.vibebrowser.app/crypto/webhook';

function signIntent(secret: string, opts: {
  uid: string; topup: string; amountUsd: string; callbackUrl: string; exp: number;
}): string {
  const p = new URLSearchParams();
  p.set('topup', opts.topup);
  p.set('uid', opts.uid);
  p.set('idtype', 'tg');
  p.set('amountUsd', opts.amountUsd);
  p.set('exp', String(opts.exp));
  p.set('callback', opts.callbackUrl);
  const canonical = [...p.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

// ── Test ─────────────────────────────────────────────────────────────────────

test.setTimeout(180_000); // tx broadcast + 12s block + polling

test('full wallet flow: pending tx → 202 → spinner → poll → Payment verified!', async ({ page }) => {
  const branchApi = process.env.BRANCH_API_URL;
  if (branchApi) {
    await page.route(url => url.pathname.includes('/api/'), async route => {
      const source = new URL(route.request().url());
      console.log('[test] proxying API request to branch:', source.pathname);
      const response = await route.fetch({ url: `${branchApi}${source.pathname.replace(/^.*\/api/, '/api')}${source.search}` });
      if (!response.ok()) console.log('[test] branch API error:', response.status(), await response.text());
      await route.fulfill({ response });
    });
  }
  // ── Wallet setup ──
  const secret = process.env.CHECKOUT_SECRET ?? '';
  if (!secret) throw new Error('CHECKOUT_SECRET env var required');

  const walletJson = JSON.parse(
    readFileSync(resolve('testnet/wallet-1.json'), 'utf8')
  ) as { privateKey: string; address: string };
  const pk = (walletJson.privateKey.startsWith('0x')
    ? walletJson.privateKey
    : `0x${walletJson.privateKey}`) as Hex;
  const account   = privateKeyToAccount(pk);
  const walletAddr = getAddress(walletJson.address);

  const publicClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(SEPOLIA_RPC) });

  // ── Expose signing bridge ──
  // eth_sendTransaction → real viem signing → returns hash IMMEDIATELY (no wait).
  // All other eth_* calls forwarded to public Sepolia RPC.
  //
  // The hash is returned before the tx is mined. This is the exact scenario of the
  // original bug: app submits the hash to the Supabase edge while tx is still pending.
  await page.exposeFunction('__testSendTx', async (txParams: Record<string, string>) => {
    console.log('[bridge] eth_sendTransaction to', txParams.to?.slice(0, 10));
    const hash = await walletClient.sendTransaction({
      to:   txParams.to as Address,
      data: (txParams.data ?? txParams.input ?? '0x') as Hex,
      // Omit gas/fees — let viem estimate fresh (avoids stale browser estimates)
    });
    console.log('[bridge] broadcast hash:', hash, '— NOT waiting for mining (tests pending path)');
    return hash;
  });

  await page.exposeFunction('__testRpcCall', async (method: string, params: unknown[]) => {
    const res = await fetch(SEPOLIA_RPC, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = await res.json() as { result?: unknown; error?: { message: string } };
    if (json.error) {
      console.warn('[bridge] RPC error', method, json.error.message);
      return null;
    }
    return json.result ?? null;
  });

  await page.addInitScript((addr: string) => {
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    const ethereum = {
      isMetaMask: true,
      selectedAddress: addr,
      on(ev: string, cb: (...a: unknown[]) => void)     { (listeners[ev] ??= []).push(cb); return ethereum; },
      removeListener(ev: string, cb: (...a: unknown[]) => void) {
        listeners[ev] = (listeners[ev] ?? []).filter(f => f !== cb); return ethereum;
      },
      emit(ev: string, ...a: unknown[]) { (listeners[ev] ?? []).forEach(f => f(...a)); },
      async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
        console.log('[eth]', method);
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain'
            || method === 'wallet_requestPermissions') return null;
        if (method === 'eth_sendTransaction')
          return await (window as any).__testSendTx((params ?? [])[0] ?? {});
        return await (window as any).__testRpcCall(method, params ?? []);
      },
    };
    (window as Window & { ethereum?: unknown }).ethereum = ethereum;
    setTimeout(() => {
      ethereum.emit('accountsChanged', [addr]);
      ethereum.emit('chainChanged', '0xaa36a7');
    }, 100);
  }, walletAddr);

  // ── Build checkout URL ──
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = signIntent(secret, {
    uid: TEST_UID, topup: TEST_TOPUP, amountUsd: AMOUNT_USD, callbackUrl: CALLBACK_URL, exp,
  });
  const qs = new URLSearchParams({
    uid: TEST_UID, topup: TEST_TOPUP, test: 'true', idtype: 'tg',
    callback: CALLBACK_URL, amountUsd: AMOUNT_USD, exp: String(exp), sig,
  });
  const payUrl = `https://pay.agentlabs.cc/pay?${qs}`;
  console.log('[test] URL:', payUrl);

  // ── Capture POST body ──
  let capturedBody: Record<string, unknown> | null = null;
  page.on('request', req => {
    if (req.url().includes('/api/payment') && req.method() === 'POST')
      try { capturedBody = JSON.parse(req.postData() ?? '{}'); } catch { /* */ }
  });
  page.on('console', msg => console.log('[browser]', msg.text()));

  // ── Navigate ──
  await page.goto(payUrl);
  await expect(page.locator('h1')).toContainText('Pay with Crypto', { timeout: 15_000 });

  // ── Select chain + token + connect wallet ──
  await page.getByRole('button', { name: /Ethereum Sepolia/i }).click();
  await page.getByRole('button', { name: 'aUSD' }).click();
  await page.locator('button[title="Connect browser wallet"]').click();
  await expect(page.getByRole('button', { name: /Pay \$5\.00 AUSD/i }))
    .toBeVisible({ timeout: 10_000 });

  // ── Pay ──
  console.log('[test] clicking Pay — tx will be pending when submitted to edge');
  await page.getByRole('button', { name: /Pay \$5\.00 AUSD/i }).click();

  // ── Assert spinner visible (proves 202 pending path was exercised) ──
  // The spinner text changes every 3s: "Waiting for confirmation... (3s)", "(6s)", etc.
  // If the edge returned 200 immediately (tx already mined), this assertion fails
  // because the app jumps straight to "Payment verified!" — which means we caught the
  // original bug scenario: the 202 path was never actually reachable.
  await expect(
    page.getByText(/Waiting for confirmation|Transaction sent. Verifying|Verifying transaction/i)
  ).toBeVisible({ timeout: 30_000 });
  console.log('[test] spinner visible — edge returned 202 (pending path confirmed)');

  // ── Wait for final verification (tx mines on Sepolia, GET re-verifies) ──
  await expect(page.getByText(/Payment verified!/i)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/[Vv]erification failed|[Tt]ransaction failed/i)).not.toBeVisible();

  // ── Final assertions ──
  expect(capturedBody, 'POST /api/payment never fired').not.toBeNull();
  expect(capturedBody!.txHash, 'txHash must be real 32-byte hex').toMatch(/^0x[0-9a-f]{64}$/i);
  expect(capturedBody!.callbackUrl).toBe(CALLBACK_URL);
  expect(capturedBody!.sig).toBe(sig);
  console.log('[test] PASS — real pending→verified cycle complete. txHash:', capturedBody!.txHash);
});
