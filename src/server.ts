import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createHmac } from "node:crypto";
import { loadConfig, type ChainId, type TokenId, TOKEN_ADDRESSES } from "./config.js";
import { createDB, type DB, insertPayment, getPaymentById, getPaymentByTx, getPaymentsByUser, markPaymentVerified, markPaymentFailed } from "./db.js";
import { verifyTransfer, resolveplan } from "./verify.js";
import { verifyTelegramInitData } from "./telegram.js";

const config = loadConfig();
const db = createDB(config.databaseUrl);
const app = new Hono();

// ── Middleware ────────────────────────────────────────────────────────

app.use("/api/*", cors({ origin: "*" }));

app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
});

// ── Health ────────────────────────────────────────────────────────────

app.get("/api/health", (c) =>
  c.json({ ok: true, chains: ["base", "eth", "ton", "sol"], tokens: ["usdt", "usdc"] })
);

// ── Public config (wallet addresses, prices) ─────────────────────────

app.get("/api/config", (c) => {
  return c.json({
    wallets: config.wallets,
    prices: config.prices,
    tokens: TOKEN_ADDRESSES,
    chains: ["base", "eth", "ton", "sol"],
  });
});

// ── Submit tx hash for verification ──────────────────────────────────

/**
 * POST /api/payment
 * Submit a transaction hash for on-chain verification.
 *
 * Body: { txHash, chainId, token, idType, uid, plan?, callbackUrl?, initData?, apiKey? }
 *
 * Auth: either Telegram initData or shared apiKey (or neither for open mode).
 */
app.post("/api/payment", async (c) => {
  const body = await c.req.json<{
    txHash: string;
    chainId: ChainId;
    token: TokenId;
    idType: "tg" | "email";
    uid: string;
    plan?: string;
    callbackUrl?: string;
    initData?: string;
    apiKey?: string;
  }>();

  // ── Auth (optional but recommended) ──
  if (body.initData && config.telegramBotToken) {
    const result = verifyTelegramInitData(body.initData, config.telegramBotToken);
    if (!result.valid) {
      return c.json({ error: "Invalid Telegram initData" }, 401);
    }
    // Override uid with verified Telegram user ID
    if (result.user) {
      body.idType = "tg";
      body.uid = String(result.user.id);
    }
  } else if (body.apiKey) {
    if (!config.apiKey || body.apiKey !== config.apiKey) {
      return c.json({ error: "Invalid API key" }, 401);
    }
  }

  // ── Validate inputs ──
  if (!body.txHash || typeof body.txHash !== "string") {
    return c.json({ error: "txHash is required" }, 400);
  }
  if (!body.chainId || !["base", "eth", "ton", "sol"].includes(body.chainId)) {
    return c.json({ error: "chainId must be base, eth, ton, or sol" }, 400);
  }
  if (!body.idType || !["tg", "email"].includes(body.idType)) {
    return c.json({ error: "idType must be 'tg' or 'email'" }, 400);
  }
  if (!body.uid) {
    return c.json({ error: "uid is required" }, 400);
  }

  const token = body.token || "usdt";
  if (!["usdt", "usdc"].includes(token)) {
    return c.json({ error: "token must be usdt or usdc" }, 400);
  }

  // ── Duplicate check ──
  const existing = getPaymentByTx(db, body.txHash, body.chainId);
  if (existing) {
    return c.json({ error: "Transaction already submitted", payment: existing }, 409);
  }

  // ── Insert pending payment ──
  const payment = insertPayment(db, {
    idType: body.idType,
    uid: body.uid,
    txHash: body.txHash,
    chainId: body.chainId,
    token,
    amountRaw: "0",
    amountUsd: 0,
    planId: body.plan ?? undefined,
  });

  // ── Verify on-chain ──
  try {
    const result = await verifyTransfer(body.txHash, body.chainId, config);

    if (!result) {
      markPaymentFailed(db, payment.id);
      const updated = getPaymentById(db, payment.id)!;
      return c.json({ payment: updated, error: "Transfer not found or not to our wallet" }, 400);
    }

    const planId = resolveplan(result.amountUsd, config.prices);

    markPaymentVerified(db, payment.id, {
      fromAddress: result.from,
      toAddress: result.to,
      amountRaw: result.amountRaw,
      amountUsd: result.amountUsd,
      blockNumber: result.blockNumber,
      planId: planId ?? body.plan ?? undefined,
    });

    const verified = getPaymentById(db, payment.id)!;

    // ── Send webhook callback ──
    if (body.callbackUrl && config.callbackSecret) {
      sendCallback(body.callbackUrl, verified).catch((err) =>
        console.error("Callback error:", err)
      );
    }

    return c.json({ payment: verified });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markPaymentFailed(db, payment.id);
    return c.json({ error: `Verification failed: ${msg}`, payment: getPaymentById(db, payment.id) }, 500);
  }
});

// ── Check payment status (API key required) ─────────────────────────

app.get("/api/payment/:id", (c) => {
  if (config.apiKey) {
    const provided = c.req.header("x-api-key") ?? c.req.query("api_key");
    if (provided !== config.apiKey) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid payment ID" }, 400);

  const payment = getPaymentById(db, id);
  if (!payment) return c.json({ error: "Payment not found" }, 404);

  return c.json({ payment });
});

// ── User payment history (API key required) ──────────────────────────

app.get("/api/payments", (c) => {
  if (config.apiKey) {
    const provided = c.req.header("x-api-key") ?? c.req.query("api_key");
    if (provided !== config.apiKey) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  const idType = c.req.query("idtype");
  const uid = c.req.query("uid");

  if (!idType || !uid) {
    return c.json({ error: "Query params idtype and uid are required" }, 400);
  }

  const payments = getPaymentsByUser(db, idType, uid);
  return c.json({ payments });
});

// ── Webhook callback ─────────────────────────────────────────────────

async function sendCallback(callbackUrl: string, payment: NonNullable<ReturnType<typeof getPaymentById>>): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = JSON.stringify({
    event: "payment.verified",
    payment: {
      id: payment.id,
      idType: payment.id_type,
      uid: payment.uid,
      plan: payment.plan_id,
      chain: payment.chain_id,
      token: payment.token,
      amountUsd: payment.amount_usd,
      txHash: payment.tx_hash,
    },
    timestamp,
  });

  const signature = createHmac("sha256", config.callbackSecret)
    .update(payload)
    .digest("hex");

  const resp = await fetch(callbackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature": signature,
      "X-Timestamp": timestamp,
    },
    body: payload,
  });

  if (!resp.ok) {
    console.error(`Callback to ${callbackUrl} failed: ${resp.status} ${resp.statusText}`);
  } else {
    console.log(`Callback sent for payment ${payment.id}`);
  }
}

// ── Payment page (Telegram Mini App) ─────────────────────────────────

app.get("/", (c) => c.html(paymentPageHtml()));

// ── Static files ─────────────────────────────────────────────────────

app.use("/*", serveStatic({ root: "./public" }));

// ── Payment page HTML (Telegram Mini App) ────────────────────────────

function paymentPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Pay with Crypto — OpenClaw</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root {
      --bg: #0a0a0a;
      --surface: #141414;
      --border: #262626;
      --text: #e5e5e5;
      --text-dim: #888;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #4ade80;
      --warning: #fbbf24;
      --error: #f87171;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 16px;
    }
    /* Telegram Mini App theme adaptation */
    body.tg-theme {
      background: var(--tg-theme-bg-color, var(--bg));
      color: var(--tg-theme-text-color, var(--text));
    }
    .container { max-width: 480px; margin: 0 auto; }
    h1 { font-size: 22px; margin-bottom: 4px; color: #fff; }
    .subtitle { color: var(--text-dim); margin-bottom: 24px; font-size: 13px; }
    .step {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 12px;
    }
    .step-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }
    .step-num {
      background: var(--accent);
      color: #fff;
      width: 24px; height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      flex-shrink: 0;
    }
    .step-title { font-size: 15px; font-weight: 600; }
    label { display: block; font-size: 12px; color: var(--text-dim); margin-bottom: 4px; margin-top: 10px; }
    label:first-of-type { margin-top: 0; }
    select, input[type="text"] {
      width: 100%;
      padding: 10px 12px;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      color: #fff;
      font-size: 14px;
      outline: none;
      -webkit-appearance: none;
    }
    select:focus, input[type="text"]:focus { border-color: var(--accent); }
    .wallet-box {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 10px 12px;
      font-family: monospace;
      font-size: 12px;
      word-break: break-all;
      color: var(--accent);
      cursor: pointer;
      transition: border-color 0.2s;
    }
    .wallet-box:active { border-color: var(--success); }
    .copy-hint { font-size: 11px; color: var(--text-dim); margin-top: 4px; text-align: right; }
    .amount-box {
      text-align: center;
      padding: 14px;
      background: #1a1a1a;
      border-radius: 8px;
      border: 1px solid #333;
    }
    .amount-box .amount { font-size: 28px; font-weight: 700; color: #fff; }
    .amount-box .token-label { color: var(--text-dim); font-size: 13px; margin-top: 2px; }
    button {
      width: 100%;
      padding: 14px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 12px;
      transition: background 0.2s;
    }
    button:hover { background: var(--accent-hover); }
    button:disabled { background: #262626; color: #666; cursor: not-allowed; }
    .status {
      margin-top: 12px;
      padding: 10px 12px;
      border-radius: 8px;
      font-size: 13px;
      display: none;
    }
    .status.pending { background: #1a1500; border: 1px solid #854d0e; color: var(--warning); display: block; }
    .status.verified { background: #001a00; border: 1px solid #166534; color: var(--success); display: block; }
    .status.failed, .status.error { background: #1a0000; border: 1px solid #991b1b; color: var(--error); display: block; }
    .chain-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
    .chain-badge {
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid #333;
      background: #1a1a1a;
      color: var(--text-dim);
      transition: all 0.2s;
    }
    .chain-badge.active {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .powered { text-align: center; margin-top: 20px; font-size: 11px; color: #333; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Pay with Crypto</h1>
    <p class="subtitle" id="userInfo">Loading...</p>

    <!-- Step 1: Choose chain & token -->
    <div class="step">
      <div class="step-header">
        <div class="step-num">1</div>
        <div class="step-title">Choose network</div>
      </div>
      <div class="chain-badges" id="chainBadges">
        <div class="chain-badge active" data-chain="base" onclick="selectChain('base')">Base</div>
        <div class="chain-badge" data-chain="eth" onclick="selectChain('eth')">Ethereum</div>
        <div class="chain-badge" data-chain="sol" onclick="selectChain('sol')">Solana</div>
        <div class="chain-badge" data-chain="ton" onclick="selectChain('ton')">TON</div>
      </div>
      <label>Token</label>
      <select id="tokenSelect" onchange="updateDisplay()">
        <option value="usdc">USDC</option>
        <option value="usdt">USDT</option>
      </select>
    </div>

    <!-- Step 2: Send payment -->
    <div class="step">
      <div class="step-header">
        <div class="step-num">2</div>
        <div class="step-title">Send payment</div>
      </div>
      <div class="amount-box">
        <div class="amount" id="amountDisplay">$10.00</div>
        <div class="token-label" id="tokenDisplay">USDC on Base</div>
      </div>
      <label>Send exactly this amount to</label>
      <div class="wallet-box" id="walletAddress" onclick="copyAddress()">Loading...</div>
      <div class="copy-hint" id="copyHint">Tap to copy</div>
    </div>

    <!-- Step 3: Submit tx hash -->
    <div class="step">
      <div class="step-header">
        <div class="step-num">3</div>
        <div class="step-title">Confirm payment</div>
      </div>
      <label>Paste your transaction hash</label>
      <input type="text" id="txHashInput" placeholder="0x... or transaction signature">
      <button id="submitBtn" onclick="submitPayment()">Verify Payment</button>
      <div class="status" id="statusMsg"></div>
    </div>

    <p class="powered">Powered by OpenClaw</p>
  </div>

  <script>
    // ── Telegram Mini App integration ──
    const tg = window.Telegram?.WebApp;
    let initData = '';
    let tgUserId = '';

    if (tg) {
      tg.ready();
      tg.expand();
      document.body.classList.add('tg-theme');
      initData = tg.initData || '';

      if (tg.initDataUnsafe?.user) {
        tgUserId = String(tg.initDataUnsafe.user.id);
      }

      // Use Telegram theme colors
      if (tg.themeParams) {
        const t = tg.themeParams;
        if (t.bg_color) document.documentElement.style.setProperty('--bg', t.bg_color);
        if (t.secondary_bg_color) document.documentElement.style.setProperty('--surface', t.secondary_bg_color);
        if (t.text_color) document.documentElement.style.setProperty('--text', t.text_color);
        if (t.hint_color) document.documentElement.style.setProperty('--text-dim', t.hint_color);
        if (t.button_color) document.documentElement.style.setProperty('--accent', t.button_color);
      }
    }

    // ── Query params (from bot-generated link) ──
    const params = new URLSearchParams(window.location.search);
    // Also check Telegram startapp param
    const startParam = tg?.initDataUnsafe?.start_param || '';
    let idType = params.get('idtype') || 'tg';
    let uid = params.get('uid') || tgUserId || '';
    let planParam = params.get('plan') || 'starter';
    let callbackUrl = params.get('callback') || '';

    // Parse startapp param: format "plan_uid" e.g. "pro_123456789"
    if (startParam && !uid) {
      const parts = startParam.split('_');
      if (parts.length >= 2) {
        planParam = parts[0];
        uid = parts.slice(1).join('_');
        idType = 'tg';
      }
    }

    let selectedChain = 'base';
    let appConfig = null;

    async function init() {
      const label = idType === 'tg'
        ? (tg?.initDataUnsafe?.user?.first_name || 'Telegram user ' + uid)
        : uid;
      document.getElementById('userInfo').textContent = uid
        ? 'Paying as ' + label + ' — ' + planParam.charAt(0).toUpperCase() + planParam.slice(1) + ' plan'
        : 'Error: No user identified';

      if (!uid) {
        document.getElementById('submitBtn').disabled = true;
        return;
      }

      try {
        const resp = await fetch('/api/config');
        appConfig = await resp.json();
        updateDisplay();
      } catch (err) {
        document.getElementById('userInfo').textContent = 'Error loading config';
      }
    }

    function selectChain(chain) {
      selectedChain = chain;
      document.querySelectorAll('.chain-badge').forEach(el => {
        el.classList.toggle('active', el.dataset.chain === chain);
      });
      updateDisplay();
    }

    function updateDisplay() {
      if (!appConfig) return;
      const token = document.getElementById('tokenSelect').value;
      const wallet = appConfig.wallets[selectedChain] || 'Not configured';
      document.getElementById('walletAddress').textContent = wallet;

      const price = appConfig.prices[planParam] || appConfig.prices.starter;
      document.getElementById('amountDisplay').textContent = '$' + price.toFixed(2);

      const chainNames = { base: 'Base', eth: 'Ethereum', sol: 'Solana', ton: 'TON' };
      document.getElementById('tokenDisplay').textContent =
        token.toUpperCase() + ' on ' + (chainNames[selectedChain] || selectedChain);
    }

    function copyAddress() {
      const addr = document.getElementById('walletAddress').textContent;
      if (!addr || addr === 'Not configured' || addr === 'Loading...') return;
      navigator.clipboard.writeText(addr).then(() => {
        document.getElementById('copyHint').textContent = 'Copied!';
        setTimeout(() => { document.getElementById('copyHint').textContent = 'Tap to copy'; }, 1500);
      });
    }

    async function submitPayment() {
      const txHash = document.getElementById('txHashInput').value.trim();
      if (!txHash) {
        showStatus('error', 'Please enter a transaction hash');
        return;
      }

      const token = document.getElementById('tokenSelect').value;
      showStatus('pending', 'Verifying transaction on-chain...');
      document.getElementById('submitBtn').disabled = true;

      try {
        const body = {
          txHash,
          chainId: selectedChain,
          token,
          idType,
          uid,
          plan: planParam,
          callbackUrl: callbackUrl || undefined,
        };

        // Include initData for Telegram auth
        if (initData) body.initData = initData;

        const resp = await fetch('/api/payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        const data = await resp.json();

        if (resp.ok && data.payment?.status === 'verified') {
          const p = data.payment;
          const planName = p.plan_id ? p.plan_id.charAt(0).toUpperCase() + p.plan_id.slice(1) : '';
          showStatus('verified',
            'Payment verified! ' + (planName ? planName + ' plan — ' : '') +
            p.amount_usd.toFixed(2) + ' ' + p.token.toUpperCase() +
            '. You can close this page.');

          // Close Telegram Mini App after short delay
          if (tg) {
            setTimeout(() => tg.close(), 3000);
          }
        } else if (resp.status === 409) {
          showStatus('error', 'This transaction was already submitted.');
        } else {
          showStatus('failed', data.error || 'Verification failed. Check the hash and try again.');
        }
      } catch (err) {
        showStatus('error', 'Network error. Please try again.');
      } finally {
        document.getElementById('submitBtn').disabled = false;
      }
    }

    function showStatus(type, msg) {
      const el = document.getElementById('statusMsg');
      el.className = 'status ' + type;
      el.textContent = msg;
    }

    init();
  </script>
</body>
</html>`;
}

// ── Start server ─────────────────────────────────────────────────────

console.log(`CryptoPayments server starting on port ${config.port}`);
serve({ fetch: app.fetch, port: config.port });
console.log(`CryptoPayments server running at http://localhost:${config.port}`);

export { app, config };
