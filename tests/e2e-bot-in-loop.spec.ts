/**
 * Real bot-in-the-loop E2E test.
 *
 * Unlike e2e-telegram-topup.spec.ts which reconstructs the checkout URL
 * client-side, this test drives the ACTUAL @OpenClawBoxBot via Telegram
 * to get the URL the bot generates. This closes the architectural gap:
 * any bug in buildCryptoCheckoutUrl (wrong signing logic, missing params,
 * wrong uid) will cause THIS test to fail — the edge function rejects
 * the malformed URL and "Payment verified!" never appears.
 *
 * Flow:
 *   1. beforeAll: mine 5 aUSD on Sepolia (same tx reused in the Playwright step)
 *   2. Run scripts/capture-topup-url.py via spawnSync → real checkout URL from bot
 *   3. Assert URL structure: sig (64-char hex), amountUsd=5.00, uid (real TG id), idtype=tg
 *   4. Open URL in Playwright with mock window.ethereum pointing to the mined tx
 *   5. Click: Ethereum Sepolia → aUSD → Connect Wallet → Pay $5.00 AUSD
 *   6. Assert "Payment verified!" from the live edge function
 *
 * Required env vars:
 *   TELEGRAM_API_ID    — Telegram app API ID (default: 1993898)
 *   TELEGRAM_API_HASH  — Telegram app API hash
 *   TELEGRAM_SESSION   — path to Telethon session (default: ~/.config/telegram/2/session.dat)
 *   CHECKOUT_SECRET or CALLBACK_SECRET — not needed (URL comes from bot, not reconstructed)
 *
 * Optional:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — poll payment_intents row for extra assertion
 */

import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, getAddress, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const EDGE_URL = 'https://krjbwbvmrpazdmmjstzo.supabase.co/functions/v1/crypto-payments';
const KNOWN_AUSD: Address = '0x76B2AeC049e93FB53f210a4B0f02fe3Dee6514C3';
const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const AMOUNT_RAW = 5_000_000n; // 5 aUSD @ 6 decimals
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

// ── Skip guard ────────────────────────────────────────────────────────────────
// If no Telegram session is available skip gracefully instead of failing CI.
// Primary eval harness session (owner account whoisdzianis). Secondary profile
// ~/.config/telegram/2 (raccoonfriendly) also works but is not the default.
const SESSION_PATH = process.env.TELEGRAM_SESSION ?? `${process.env.HOME}/.config/telethon/session.dat`;
const hasTelegramSession = (() => {
  try {
    statSync(`${SESSION_PATH}.session`);
    return true;
  } catch { return false; }
})();
const SKIP_REASON = hasTelegramSession
  ? null
  : `TELEGRAM_SESSION file not found at ${SESSION_PATH}.session — set TELEGRAM_SESSION env var`;

let realTxHash: Hex;
let realBlockNumber: bigint;
let botCheckoutUrl: string;

test.beforeAll(async () => {
  // ── Step 1: Mine 5 aUSD on Sepolia ────────────────────────────────────────
  const walletPath = resolve(PROJECT_ROOT, 'testnet/wallet-1.json');
  const w = JSON.parse(readFileSync(walletPath, 'utf8')) as { privateKey: string };
  const pk = (w.privateKey.startsWith('0x') ? w.privateKey : `0x${w.privateKey}`) as Hex;
  const account = privateKeyToAccount(pk);

  const cfgResp = await fetch(`${EDGE_URL}/api/config`);
  if (!cfgResp.ok) throw new Error(`config fetch failed: ${cfgResp.status}`);
  const cfg = await cfgResp.json() as {
    wallets: Record<string, string>;
    tokens: Record<string, Record<string, string>>;
  };

  const recipient: Address = getAddress(cfg.wallets.eth_sepolia);
  const ausdAddr: Address = cfg.tokens?.eth_sepolia?.ausd
    ? getAddress(cfg.tokens.eth_sepolia.ausd)
    : KNOWN_AUSD;

  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(SEPOLIA_RPC) });
  const publicClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });

  console.log(`[beforeAll] sending 5 aUSD → ${recipient} on Sepolia (bot-in-loop test)...`);
  const hash = await walletClient.writeContract({
    address: ausdAddr, abi: ERC20_ABI, functionName: 'transfer', args: [recipient, AMOUNT_RAW],
  });
  console.log(`[beforeAll] tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success') throw new Error(`tx reverted: ${hash}`);
  realTxHash = hash;
  realBlockNumber = receipt.blockNumber;
  console.log(`[beforeAll] confirmed block=${receipt.blockNumber}`);

  // ── Step 2: Drive bot via Telegram to get real checkout URL ───────────────
  if (!hasTelegramSession) {
    console.warn(`[beforeAll] Skipping bot URL capture: ${SKIP_REASON}`);
    return;
  }

  const apiId = process.env.TELEGRAM_API_ID ?? '1993898';
  const apiHash = process.env.TELEGRAM_API_HASH ?? '59d1e009d7ecb0c0a7224af3f461bb2e';
  const scriptPath = resolve(PROJECT_ROOT, 'scripts/capture-topup-url.py');

  console.log('[beforeAll] running capture-topup-url.py...');
  const result = spawnSync(
    'python3',
    [
      scriptPath,
      '--session', SESSION_PATH,
      '--api-id', apiId,
      '--api-hash', apiHash,
      '--bot', '@OpenClawBoxBot',
    ],
    { encoding: 'utf8', timeout: 90_000 },
  );

  // Diagnostic output always goes to stderr in the Python script
  if (result.stderr) {
    for (const line of result.stderr.trim().split('\n')) {
      console.log(`[capture-topup-url] ${line}`);
    }
  }

  if (result.error) throw new Error(`capture-topup-url.py process error: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`capture-topup-url.py exited with code ${result.status}`);
  }

  const rawUrl = result.stdout.trim();
  if (!rawUrl) throw new Error('capture-topup-url.py produced no output');

  botCheckoutUrl = rawUrl;
  console.log(`[beforeAll] bot URL: ${botCheckoutUrl}`);
});

test('bot-in-loop: real /topup URL → mock wallet → real edge → Payment verified!', async ({ page }) => {
  if (SKIP_REASON) {
    test.skip(true, SKIP_REASON);
    return;
  }
  if (!botCheckoutUrl) {
    test.fail(true, 'botCheckoutUrl was not captured in beforeAll');
    return;
  }

  // ── Assert URL structure ───────────────────────────────────────────────────
  const parsed = new URL(botCheckoutUrl);
  const p = parsed.searchParams;

  expect(p.get('sig'), 'sig must be 64-char HMAC-SHA256 hex from bot').toMatch(/^[a-f0-9]{64}$/);
  expect(p.get('amountUsd'), 'amountUsd must be 5.00').toBe('5.00');
  expect(p.get('idtype'), 'idtype must be tg').toBe('tg');
  expect(p.get('uid'), 'uid must be present (real user Telegram ID)').toBeTruthy();
  expect(p.get('topup'), 'topup must be small').toBe('small');
  expect(p.get('exp'), 'exp must be set (Unix timestamp)').toBeTruthy();
  // callback is injected by the bot (cryptoCallbackUrl config value)
  expect(p.get('callback'), 'callback must be set by bot').toBeTruthy();

  console.log(`[test] uid=${p.get('uid')} sig=${p.get('sig')!.slice(0, 8)}...`);

  // ── Set up Playwright with mock ethereum ──────────────────────────────────
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
            case 'eth_chainId': return '0xaa36a7'; // Sepolia
            case 'net_version': return '11155111';
            case 'wallet_switchEthereumChain':
            case 'wallet_addEthereumChain': return null;
            case 'eth_getTransactionCount': return '0x1';
            case 'eth_estimateGas': return '0x14000';
            case 'eth_gasPrice': return '0x3b9aca00';
            case 'eth_maxFeePerGas': return '0x77359400';
            case 'eth_maxPriorityFeePerGas': return '0x3b9aca00';
            case 'eth_feeHistory': return {
              baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'],
              gasUsedRatio: [0.5],
              reward: [['0x3b9aca00']],
              oldestBlock: blockHex,
            };
            case 'eth_sendTransaction': return txHash;
            case 'eth_getTransactionByHash': return {
              hash: txHash, nonce: '0x1',
              blockHash: '0x' + '1'.padStart(64, '0'), blockNumber: blockHex,
              transactionIndex: '0x0', from: walletAddr,
              to: '0x76B2AeC049e93FB53f210a4B0f02fe3Dee6514C3',
              value: '0x0', gas: '0x14000',
              maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00',
              chainId: '0xaa36a7', accessList: [],
              input: '0xa9059cbb' + '0'.repeat(24) + walletAddr.slice(2).toLowerCase() + '0000000000000000000000000000000000000000000000000000000000004c4b40',
              type: '0x2', r: '0x' + 'a'.repeat(64), s: '0x' + 'b'.repeat(64), v: '0x0', yParity: '0x0',
            };
            case 'eth_getTransactionReceipt': return {
              transactionHash: txHash, transactionIndex: '0x0',
              blockHash: '0x' + '1'.padStart(64, '0'), blockNumber: blockHex,
              from: walletAddr, to: '0x76B2AeC049e93FB53f210a4B0f02fe3Dee6514C3',
              cumulativeGasUsed: '0x14000', gasUsed: '0x8000',
              logs: [], status: '0x1', type: '0x2',
            };
            case 'eth_blockNumber': return blockHex;
            case 'eth_getBlockByNumber': return {
              number: blockHex, hash: '0x' + '1'.padStart(64, '0'),
              parentHash: '0x' + '0'.padStart(64, '0'),
              baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0',
              miner: walletAddr, nonce: '0x0000000000000000', timestamp: '0x0', transactions: [],
            };
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

  // Intercept POST to /api/payment to assert the edge receives the bot's callback URL
  let capturedPaymentBody: Record<string, unknown> | null = null;
  page.on('request', req => {
    if (req.url().includes('/api/payment') && req.method() === 'POST') {
      try { capturedPaymentBody = JSON.parse(req.postData() ?? '{}'); } catch { /* ignore */ }
    }
  });

  // ── Open the bot's real checkout URL ──────────────────────────────────────
  // Append test=true so the webapp shows Ethereum Sepolia chain selector.
  // This param is a pure UI display toggle — it is NOT included in the sig
  // canonical (the bot doesn't set it and the edge doesn't read it). Safe to add.
  const playUrl = new URL(botCheckoutUrl);
  playUrl.searchParams.set('test', 'true');
  console.log(`[test] opening: ${playUrl.toString()}`);
  await page.goto(playUrl.toString());
  await expect(page.locator('h1')).toContainText('Pay with Crypto', { timeout: 15_000 });

  // Select chain
  await page.getByRole('button', { name: /Ethereum Sepolia/i }).click();
  // Select token
  await page.getByRole('button', { name: 'aUSD' }).click();
  // Connect wallet
  await page.getByRole('button', { name: 'Connect Wallet' }).click();

  // Wait for Pay button
  const payBtn = page.getByRole('button', { name: /Pay \$5\.00 AUSD/i });
  await expect(payBtn).toBeVisible({ timeout: 10_000 });
  await payBtn.click();

  // Assert success — edge verifies the real on-chain tx
  await expect(page.getByText(/Payment verified!/i)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/verification failed/i)).not.toBeVisible();

  // ── Assert edge received the bot's callback URL ────────────────────────────
  // This is the key regression guard for the bot-in-loop path:
  // if callback is absent from the POST body, credits are never applied.
  expect(capturedPaymentBody, 'POST to /api/payment was never intercepted').not.toBeNull();
  expect(capturedPaymentBody!.callbackUrl, 'callbackUrl must flow through from bot URL').toBe(p.get('callback'));
  expect(capturedPaymentBody!.sig, 'sig must match bot-signed value').toBe(p.get('sig'));
  expect(capturedPaymentBody!.amountUsd, 'amountUsd must be 5.00').toBe('5.00');
  expect(capturedPaymentBody!.uid, 'uid must match bot URL uid').toBe(p.get('uid'));
  expect(capturedPaymentBody!.topup, 'topup must be small').toBe('small');

  // ── Optionally confirm Supabase row ──────────────────────────────────────
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
    if (paymentRow) {
      expect(paymentRow.status, 'Payment row status must be succeeded').toBe('succeeded');
    } else {
      console.warn(`[test] payment_intents row not found for tx ${txHash} (SUPABASE_SERVICE_ROLE_KEY set but row missing)`);
    }
  }

  console.log(`[test] PASS — bot URL uid=${p.get('uid')} tx=${txHash}`);
});
