/**
 * Full wallet flow E2E — real sendEvmTransfer path.
 *
 * Improvement over e2e-telegram-topup.spec.ts:
 *  - No pre-sent tx in beforeAll.
 *  - window.ethereum mock bridges eth_sendTransaction to a real viem wallet client
 *    via page.exposeFunction — so ethers.js in the browser builds the real ERC-20 tx,
 *    and our Node.js proxy signs + sends it on Sepolia, returns the real hash.
 *  - Validates the sendEvmTransfer code path end-to-end (including getAddress fix).
 *  - Real tx confirmed → real Supabase edge verification → "Payment verified!".
 *
 * Required env vars:
 *   CHECKOUT_SECRET   — HMAC secret (= OpenClawBot's CRYPTO_CALLBACK_SECRET)
 *   testnet/wallet-1.json  — funded Sepolia wallet (enough ETH + aUSD)
 */

import { test, expect, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient, createWalletClient, http,
  getAddress, type Hex, type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

// ── Constants ───────────────────────────────────────────────────────────────
const EDGE_URL   = 'https://krjbwbvmrpazdmmjstzo.supabase.co/functions/v1/crypto-payments';
const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const AMOUNT_USD = '5.00';
const TEST_UID   = '999888777';
const TEST_TOPUP = 'small';
const CALLBACK_URL = 'https://admin.openclaw.vibebrowser.app/crypto/webhook';

// ── Helpers ─────────────────────────────────────────────────────────────────
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

/**
 * Wire up the page.exposeFunction bridge so that when the app calls
 * window.ethereum.request({method:'eth_sendTransaction', params:[txData]}),
 * we sign and broadcast the tx for real on Sepolia using the test wallet.
 *
 * All other eth_* calls are forwarded to the public Sepolia RPC — the
 * browser never talks to the chain directly, so the mock is purely a signing
 * proxy that also reports the wallet address.
 */
async function injectRealSigningWallet(
  page: Page,
  walletAddr: string,
  opts: {
    sendTx: (txParams: Record<string, string>) => Promise<string>;
    rpcCall: (method: string, params: unknown[]) => Promise<unknown>;
  },
) {
  // Expose Node.js functions to the browser sandbox
  await page.exposeFunction('__testSendTx', opts.sendTx);
  await page.exposeFunction('__testRpcCall', opts.rpcCall);

  await page.addInitScript((addr: string) => {
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    const ethereum = {
      isMetaMask: true,
      selectedAddress: addr,
      on(ev: string, cb: (...a: unknown[]) => void) {
        (listeners[ev] ??= []).push(cb);
        return ethereum;
      },
      removeListener(ev: string, cb: (...a: unknown[]) => void) {
        listeners[ev] = (listeners[ev] ?? []).filter(f => f !== cb);
        return ethereum;
      },
      emit(ev: string, ...a: unknown[]) {
        (listeners[ev] ?? []).forEach(f => f(...a));
      },
      async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
        console.log('[eth proxy]', method);
        switch (method) {
          // Identity — always return the test wallet address
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return [addr];
          // Chain switching — accepted, no-op (we're already on Sepolia)
          case 'wallet_switchEthereumChain':
          case 'wallet_addEthereumChain':
          case 'wallet_requestPermissions':
            return null;
          // REAL signing: bridge to Node.js viem wallet
          case 'eth_sendTransaction':
            return await (window as any).__testSendTx((params ?? [])[0] ?? {});
          // Everything else: forward to Sepolia RPC via Node.js proxy
          default:
            return await (window as any).__testRpcCall(method, params ?? []);
        }
      },
    };
    (window as Window & { ethereum?: unknown }).ethereum = ethereum;
    setTimeout(() => {
      ethereum.emit('accountsChanged', [addr]);
      ethereum.emit('chainChanged', '0xaa36a7'); // sepolia
    }, 100);
  }, walletAddr);
}

// ── Test ─────────────────────────────────────────────────────────────────────
test.describe('Full wallet flow — real sendEvmTransfer → real edge verify', () => {
  test('Telegram /topup link → connect wallet → Pay → real Sepolia tx → Payment verified!', async ({ page }) => {
    // ── Setup ──
    const secret = process.env.CHECKOUT_SECRET ?? process.env.CALLBACK_SECRET ?? '';
    if (!secret) throw new Error('CHECKOUT_SECRET must be set');

    const walletJson = JSON.parse(readFileSync(resolve('testnet/wallet-1.json'), 'utf8')) as { privateKey: string; address: string };
    const pk = (walletJson.privateKey.startsWith('0x') ? walletJson.privateKey : `0x${walletJson.privateKey}`) as Hex;
    const account = privateKeyToAccount(pk);
    const walletAddr = getAddress(walletJson.address);

    const publicClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
    const walletClient = createWalletClient({ account, chain: sepolia, transport: http(SEPOLIA_RPC) });

    // Fetch live config so we use the real recipient address
    const cfg = await (await fetch(`${EDGE_URL}/api/config`)).json() as {
      wallets: Record<string, string>;
      tokens: Record<string, Record<string, string>>;
    };
    const recipient: Address = getAddress(cfg.wallets.eth_sepolia);
    console.log(`[test] recipient: ${recipient}`);

    // ── Expose signing bridge ──
    await injectRealSigningWallet(page, walletAddr, {
      /**
       * eth_sendTransaction from the browser →
       *   1. Receives the unsigned tx ethers.js built (recipient=recipient, data=ERC-20 transfer)
       *   2. viem signs + broadcasts on Sepolia using the test wallet's private key
       *   3. Waits for 1 confirmation (so Supabase edge can find the receipt immediately)
       *   4. Returns the real on-chain hash
       */
      async sendTx(txParams) {
        console.log('[test:sendTx] intercepted eth_sendTransaction to:', txParams.to);
        const hash = await walletClient.sendTransaction({
          to: txParams.to as Address,
          data: (txParams.data ?? txParams.input ?? '0x') as Hex,
          gas: txParams.gas ? BigInt(txParams.gas) : undefined,
          maxFeePerGas: txParams.maxFeePerGas ? BigInt(txParams.maxFeePerGas) : undefined,
          maxPriorityFeePerGas: txParams.maxPriorityFeePerGas ? BigInt(txParams.maxPriorityFeePerGas) : undefined,
          value: txParams.value ? BigInt(txParams.value) : 0n,
        });
        console.log(`[test:sendTx] sent: ${hash} — waiting for receipt...`);
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
        if (receipt.status !== 'success') throw new Error(`tx reverted: ${hash}`);
        console.log(`[test:sendTx] confirmed block=${receipt.blockNumber}`);
        return hash;
      },
      /**
       * Forward all other eth_* calls to the real Sepolia JSON-RPC.
       * This gives ethers.js real nonces, gas estimates, and block data —
       * the mock only intercepts account identity and transaction signing.
       */
      async rpcCall(method, params) {
        const res = await fetch(SEPOLIA_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        const json = await res.json() as { result?: unknown; error?: { message: string } };
        if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
        return json.result ?? null;
      },
    });

    // ── Build checkout URL (mirrors buildCryptoCheckoutUrl in OpenClawBot) ──
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sig = signIntent(secret, { uid: TEST_UID, topup: TEST_TOPUP, amountUsd: AMOUNT_USD, callbackUrl: CALLBACK_URL, exp });
    const qs = new URLSearchParams({
      uid: TEST_UID, topup: TEST_TOPUP, test: 'true', idtype: 'tg',
      callback: CALLBACK_URL, amountUsd: AMOUNT_USD, exp: String(exp), sig,
    });
    const payUrl = `https://pay.agentlabs.cc/pay?${qs}`;
    console.log('[test] checkout URL:', payUrl);

    // ── Capture POST body ──
    let capturedPaymentBody: Record<string, unknown> | null = null;
    page.on('request', req => {
      if (req.url().includes('/api/payment') && req.method() === 'POST') {
        try { capturedPaymentBody = JSON.parse(req.postData() ?? '{}'); } catch { /* ignore */ }
      }
    });
    page.on('console', msg => console.log(`[browser] ${msg.text()}`));

    // ── Navigate ──
    await page.goto(payUrl);
    await expect(page.locator('h1')).toContainText('Pay with Crypto', { timeout: 15_000 });

    // ── Step 1: Select chain (Ethereum Sepolia — where wallet has funds) ──
    await page.getByRole('button', { name: /Ethereum Sepolia/i }).click();

    // ── Step 2: Select token ──
    await page.getByRole('button', { name: 'aUSD' }).click();

    // ── Step 3: Connect browser wallet ──
    await page.locator('button[title="Connect browser wallet"]').click();
    await expect(page.getByRole('button', { name: /Pay \$5\.00 AUSD/i })).toBeVisible({ timeout: 10_000 });

    // ── Step 4: Pay — triggers real sendEvmTransfer → real Sepolia tx ──
    console.log('[test] clicking Pay...');
    await page.getByRole('button', { name: /Pay \$5\.00 AUSD/i }).click();

    // Wait for tx send (can take 30–90s for mining)
    await expect(page.getByText(/Waiting for confirmation|Transaction sent|Payment verified/i))
      .toBeVisible({ timeout: 60_000 });

    // ── Step 5: Verify end result ──
    await expect(page.getByText(/Payment verified!/i)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(/verification failed/i)).not.toBeVisible();

    // ── Assertions on POST body ──
    expect(capturedPaymentBody, 'POST /api/payment never fired').not.toBeNull();
    expect(capturedPaymentBody!.callbackUrl).toBe(CALLBACK_URL);
    expect(capturedPaymentBody!.sig).toBe(sig);
    expect(capturedPaymentBody!.uid).toBe(TEST_UID);
    expect(capturedPaymentBody!.topup).toBe(TEST_TOPUP);
    expect(capturedPaymentBody!.txHash, 'txHash must be a real 32-byte hex').toMatch(/^0x[0-9a-f]{64}$/i);
    console.log('[test] PASS — txHash:', capturedPaymentBody!.txHash);
  });
});
