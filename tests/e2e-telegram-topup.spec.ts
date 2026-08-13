/**
 * E2E test for the FULL Telegram /topup flow.
 *
 * Simulates exactly what happens when a user clicks the link the bot sends:
 *   1. Reconstruct the checkout URL using the same HMAC signing logic the bot uses
 *      (buildCryptoCheckoutUrl in OpenClawBot calls signIntent with the same params)
 *   2. Assert the URL has the shape the bot generates (callbackUrl, sig, amountUsd=5)
 *   3. Open the URL in the browser — same as clicking the bot's Telegram message
 *   4. Mock window.ethereum to return a real on-chain tx hash (mined in beforeAll)
 *   5. Click through: chain → token → connect wallet → pay
 *   6. Assert "Payment verified!" from the edge function
 *   7. Assert the POST body to the edge includes callbackUrl so credits are applied
 */

import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, getAddress, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const EDGE_URL = 'https://krjbwbvmrpazdmmjstzo.supabase.co/functions/v1/crypto-payments';
const KNOWN_AUSD: Address = '0x76B2AeC049e93FB53f210a4B0f02fe3Dee6514C3';
const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const AMOUNT_RAW = 5_000_000n; // 5 aUSD @ 6 decimals
const AMOUNT_USD = '5.00';
const TEST_UID = '999999999';
const TEST_TOPUP = 'small';
// This is the bot's resolved cryptoCallbackUrl — the value OpenClawBot injects into every checkout link
const CALLBACK_URL = 'https://admin.openclaw.vibebrowser.app/crypto/webhook';
const WALLET_ADDR = '0x64cd33D639Cbb0b461c64ec989a7d9789d701a30';

const ERC20_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

let realTxHash: Hex;
let realBlockNumber: bigint;
let secret: string;

/**
 * Mirrors the signIntent implementation used by buildCryptoCheckoutUrl in OpenClawBot.
 * Sorted params → HMAC-SHA256 → hex digest.
 */
function signIntent(sigSecret: string, opts: {
  uid: string; topup: string; amountUsd: string; callbackUrl: string; exp: number;
}): string {
  const params = new URLSearchParams();
  params.set('topup', opts.topup);
  params.set('uid', opts.uid);
  params.set('idtype', 'tg');
  params.set('amountUsd', opts.amountUsd);
  params.set('exp', String(opts.exp));
  params.set('callback', opts.callbackUrl);
  const canonical = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  return createHmac('sha256', sigSecret).update(canonical).digest('hex');
}

test.beforeAll(async () => {
  secret = process.env.CHECKOUT_SECRET ?? process.env.CALLBACK_SECRET ?? '';
  if (!secret) throw new Error('CHECKOUT_SECRET or CALLBACK_SECRET must be set');

  const walletPath = resolve('testnet/wallet-1.json');
  const w = JSON.parse(readFileSync(walletPath, 'utf8')) as { privateKey: string };
  const pk = (w.privateKey.startsWith('0x') ? w.privateKey : `0x${w.privateKey}`) as Hex;
  const account = privateKeyToAccount(pk);

  const cfgResp = await fetch(`${EDGE_URL}/api/config`);
  if (!cfgResp.ok) throw new Error(`config fetch failed: ${cfgResp.status}`);
  const cfg = await cfgResp.json() as { wallets: Record<string, string>; tokens: Record<string, Record<string, string>> };

  const recipient: Address = getAddress(cfg.wallets.eth_sepolia);
  const ausdAddr: Address = cfg.tokens?.eth_sepolia?.ausd ? getAddress(cfg.tokens.eth_sepolia.ausd) : KNOWN_AUSD;

  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(SEPOLIA_RPC) });
  const publicClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });

  console.log(`[beforeAll] sending 5 aUSD → ${recipient} on Sepolia (telegram topup test)...`);
  const hash = await walletClient.writeContract({
    address: ausdAddr, abi: ERC20_ABI, functionName: 'transfer', args: [recipient, AMOUNT_RAW],
  });
  console.log(`[beforeAll] tx: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success') throw new Error(`tx reverted: ${hash}`);

  realTxHash = hash;
  realBlockNumber = receipt.blockNumber;
  console.log(`[beforeAll] confirmed block=${receipt.blockNumber}`);
});

test('telegram /topup flow: checkout URL → mock wallet → real edge → Payment verified!', async ({ page }) => {
  const branchApi = process.env.BRANCH_API_URL;
  if (branchApi) {
    await page.route(url => url.pathname.includes('/api/'), async route => {
      const source = new URL(route.request().url());
      console.log('[test] proxying API request to branch:', source.pathname);
      const response = await route.fetch({ url: `${branchApi}${source.pathname.replace(/^.*\/api/, '/api')}${source.search}` });
      await route.fulfill({ response });
    });
  }
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = signIntent(secret, { uid: TEST_UID, topup: TEST_TOPUP, amountUsd: AMOUNT_USD, callbackUrl: CALLBACK_URL, exp });

  // Build the checkout URL exactly as the bot does via buildCryptoCheckoutUrl
  const qs = new URLSearchParams({
    uid: TEST_UID, topup: TEST_TOPUP, test: 'true', idtype: 'tg',
    callback: CALLBACK_URL, amountUsd: AMOUNT_USD, exp: String(exp), sig,
  });
  // Bot uses pay.agentlabs.cc as its cryptoPaymentsUrl base (confirmed from live pod config)
  const payUrl = `https://pay.agentlabs.cc/pay?${qs}`;
  console.log(`[test] Telegram checkout URL: ${payUrl}`);

  // sig must be 64-char hex from HMAC-SHA256
  expect(sig, 'sig must be 64-char HMAC-SHA256 hex').toMatch(/^[a-f0-9]{64}$/);

  const blockHex = '0x' + (realBlockNumber + 10n).toString(16);
  const txHash = realTxHash;
  console.log(`[test] using on-chain tx: ${txHash}`);

  await page.addInitScript(
    ({ txHash, blockHex, walletAddr }: { txHash: string; blockHex: string; walletAddr: string }) => {
      const _listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
      const ethereum = {
        isMetaMask: true,
        selectedAddress: walletAddr,
        on(event: string, cb: (...args: unknown[]) => void) {
          (_listeners[event] = _listeners[event] || []).push(cb);
          return ethereum;
        },
        removeListener(event: string, cb: (...args: unknown[]) => void) {
          _listeners[event] = (_listeners[event] || []).filter(f => f !== cb);
          return ethereum;
        },
        emit(event: string, ...args: unknown[]) {
          (_listeners[event] || []).forEach(f => f(...args));
        },
        async request({ method }: { method: string; params?: unknown[] }): Promise<unknown> {
          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              return [walletAddr];
            case 'eth_chainId': return '0xaa36a7';
            case 'net_version': return '11155111';
            case 'wallet_switchEthereumChain':
            case 'wallet_addEthereumChain': return null;
            case 'eth_getTransactionCount': return '0x1';
            case 'eth_estimateGas': return '0x14000';
            case 'eth_gasPrice': return '0x3b9aca00';
            case 'eth_maxFeePerGas': return '0x77359400';
            case 'eth_maxPriorityFeePerGas': return '0x3b9aca00';
            case 'eth_feeHistory': return { baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'], gasUsedRatio: [0.5], reward: [['0x3b9aca00']], oldestBlock: blockHex };
            case 'eth_sendTransaction': return txHash;
            case 'eth_getTransactionByHash': return { hash: txHash, nonce: '0x1', blockHash: '0x' + '1'.padStart(64, '0'), blockNumber: blockHex, transactionIndex: '0x0', from: walletAddr, to: '0x76B2AeC049e93FB53f210a4B0f02fe3Dee6514C3', value: '0x0', gas: '0x14000', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', chainId: '0xaa36a7', accessList: [], input: '0xa9059cbb000000000000000000000000' + walletAddr.slice(2).toLowerCase().padStart(64, '0') + '0000000000000000000000000000000000000000000000000000000000004c4b40', type: '0x2', r: '0x' + 'a'.repeat(64), s: '0x' + 'b'.repeat(64), v: '0x0', yParity: '0x0' };
            case 'eth_getTransactionReceipt': return { transactionHash: txHash, transactionIndex: '0x0', blockHash: '0x' + '1'.padStart(64, '0'), blockNumber: blockHex, from: walletAddr, to: '0x76B2AeC049e93FB53f210a4B0f02fe3Dee6514C3', cumulativeGasUsed: '0x14000', gasUsed: '0x8000', logs: [], status: '0x1', type: '0x2' };
            case 'eth_blockNumber': return blockHex;
            case 'eth_getBlockByNumber': return { number: blockHex, hash: '0x' + '1'.padStart(64, '0'), parentHash: '0x' + '0'.padStart(64, '0'), baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', miner: walletAddr, nonce: '0x0000000000000000', timestamp: '0x0', transactions: [] };
            case 'wallet_requestPermissions': return [{ parentCapability: 'eth_accounts' }];
            default: console.warn('[eth mock] unhandled:', method); return null;
          }
        },
      };
      (window as Window & { ethereum?: unknown }).ethereum = ethereum;
      setTimeout(() => {
        ethereum.emit('accountsChanged', [walletAddr]);
        ethereum.emit('chainChanged', '0xaa36a7');
      }, 100);
    },
    { txHash, blockHex, walletAddr: WALLET_ADDR }
  );

  page.on('console', msg => console.log(`[browser ${msg.type()}] ${msg.text()}`));

  // Intercept the POST to assert the webapp builds the correct body.
  // callbackUrl flowing through is the entire reason this Telegram path test exists —
  // if it's dropped, the bot never gets notified and credits are never applied.
  let capturedPaymentBody: Record<string, unknown> | null = null;
  page.on('request', req => {
    if (req.url().includes('/api/payment') && req.method() === 'POST') {
      try { capturedPaymentBody = JSON.parse(req.postData() ?? '{}'); } catch { /* ignore */ }
    }
  });

  // Open the bot's checkout URL — this is exactly what happens when the user taps
  // the link in Telegram
  await page.goto(payUrl);

  // Wait for page to fully load (config fetched, spinner gone)
  await expect(page.locator('h1')).toContainText('Pay with Crypto', { timeout: 15_000 });

  // Select Ethereum Sepolia chain
  await page.getByRole('button', { name: /Ethereum Sepolia/i }).click();

  // Select aUSD token
  await page.getByRole('button', { name: 'aUSD' }).click();

  // Connect wallet — use browser wallet (injected mock ethereum)
  await page.locator('button[title="Connect browser wallet"]').click();

  // Wait for Pay button to appear (means wallet connected)
  const payBtn = page.getByRole('button', { name: /Pay \$5\.00 AUSD/i });
  await expect(payBtn).toBeVisible({ timeout: 10_000 });

  // Click Pay
  await payBtn.click();

  // Wait for "Payment verified!" — the edge verifies the real on-chain tx
  await expect(page.getByText(/Payment verified!/i)).toBeVisible({ timeout: 60_000 });

  // Assert no error visible
  await expect(page.getByText(/verification failed/i)).not.toBeVisible();
  await expect(page.getByText(/transaction failed/i)).not.toBeVisible();

  // Verify the POST body the webapp sent to the edge.
  // These are the regression guards for the Telegram path:
  //   - callbackUrl must flow through so the bot's webhook fires and credits are applied
  //   - sig must match what the bot signed (tamper-detection)
  expect(capturedPaymentBody, 'POST to /api/payment was never intercepted').not.toBeNull();
  expect(capturedPaymentBody!.callbackUrl, 'callbackUrl missing from POST body — bot will not receive credit notification').toBe(CALLBACK_URL);
  expect(capturedPaymentBody!.sig, 'sig missing from POST body').toBe(sig);
  expect(capturedPaymentBody!.amountUsd, 'amountUsd missing from POST body').toBe(AMOUNT_USD);
  expect(capturedPaymentBody!.uid, 'uid missing from POST body').toBe(TEST_UID);
  expect(capturedPaymentBody!.topup, 'topup missing from POST body').toBe(TEST_TOPUP);

  // Poll Supabase payment_intents table — confirm the tx was recorded server-side
  const supabaseUrl = process.env.SUPABASE_URL ?? 'https://krjbwbvmrpazdmmjstzo.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (supabaseKey) {
    let paymentRow: Record<string, unknown> | null = null;
    for (let i = 0; i < 10; i++) {
      const resp = await fetch(
        `${supabaseUrl}/rest/v1/payment_intents?select=*&tx_hash=eq.${txHash}&limit=1`,
        { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
      );
      const rows = await resp.json() as Record<string, unknown>[];
      if (rows.length > 0) { paymentRow = rows[0]; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    expect(paymentRow, 'Payment row not found in Supabase for tx ' + txHash).not.toBeNull();
    expect(paymentRow!.status, 'Payment status must be succeeded').toBe('succeeded');
  }

  console.log(`[test] PASS — tx: ${txHash}`);
});
