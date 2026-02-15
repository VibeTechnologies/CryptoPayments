import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { loadConfig, type ChainId, type TokenId, TOKEN_ADDRESSES } from "./config.js";
import { createDB, insertPayment, getPaymentById, getPaymentByTx, getPaymentsByUser, markPaymentVerified, markPaymentFailed } from "./db.js";
import { verifyTransfer, resolveplan } from "./verify.js";

const config = loadConfig();
const db = createDB(config.databaseUrl);
const app = new Hono();

// ── Static files (payment page) ──────────────────────────────────────

app.use("/static/*", serveStatic({ root: "./" }));

// ── Payment page ─────────────────────────────────────────────────────

app.get("/", (c) => {
  // Query params: idtype=tg|email, uid=<value>, plan=starter|pro|max (optional)
  // Serve the HTML page; frontend reads query params
  return c.html(paymentPageHtml());
});

// ── API routes ───────────────────────────────────────────────────────

/**
 * POST /api/payment
 * Submit a transaction hash for verification.
 * Body: { txHash, chainId, token, idType, uid }
 */
app.post("/api/payment", async (c) => {
  const body = await c.req.json<{
    txHash: string;
    chainId: ChainId;
    token: TokenId;
    idType: "tg" | "email";
    uid: string;
  }>();

  // Validate inputs
  if (!body.txHash || !body.chainId || !body.idType || !body.uid) {
    return c.json({ error: "Missing required fields: txHash, chainId, idType, uid" }, 400);
  }

  const validChains: ChainId[] = ["base", "eth", "ton", "sol"];
  if (!validChains.includes(body.chainId)) {
    return c.json({ error: `Invalid chainId. Must be one of: ${validChains.join(", ")}` }, 400);
  }

  if (body.idType !== "tg" && body.idType !== "email") {
    return c.json({ error: "idType must be 'tg' or 'email'" }, 400);
  }

  // Check for duplicate
  const existing = getPaymentByTx(db, body.txHash, body.chainId);
  if (existing) {
    return c.json({ error: "Transaction already submitted", payment: existing }, 409);
  }

  // Insert pending record
  const payment = insertPayment(db, {
    idType: body.idType,
    uid: body.uid,
    txHash: body.txHash,
    chainId: body.chainId,
    token: body.token || "usdt",
    amountRaw: "0",
    amountUsd: 0,
  });

  // Verify on-chain (async — we already responded with the record)
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
      planId: planId ?? undefined,
    });

    const verified = getPaymentById(db, payment.id)!;
    return c.json({ payment: verified });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markPaymentFailed(db, payment.id);
    return c.json({ error: `Verification failed: ${msg}`, payment: getPaymentById(db, payment.id) }, 500);
  }
});

/**
 * GET /api/payment/:id
 * Check payment status by ID.
 */
app.get("/api/payment/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid payment ID" }, 400);

  const payment = getPaymentById(db, id);
  if (!payment) return c.json({ error: "Payment not found" }, 404);

  return c.json({ payment });
});

/**
 * GET /api/payments?idtype=tg&uid=12345
 * List payments for a user.
 */
app.get("/api/payments", (c) => {
  const idType = c.req.query("idtype");
  const uid = c.req.query("uid");

  if (!idType || !uid) {
    return c.json({ error: "Query params idtype and uid are required" }, 400);
  }

  const payments = getPaymentsByUser(db, idType, uid);
  return c.json({ payments });
});

/**
 * GET /api/config
 * Return public config (wallet addresses, prices, supported chains).
 */
app.get("/api/config", (c) => {
  return c.json({
    wallets: config.wallets,
    prices: config.prices,
    tokens: TOKEN_ADDRESSES,
    chains: ["base", "eth", "ton", "sol"],
  });
});

// ── Payment Page HTML ────────────────────────────────────────────────

function paymentPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pay with Crypto — OpenClaw</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 40px 16px;
    }
    .container {
      max-width: 480px;
      width: 100%;
    }
    h1 {
      font-size: 24px;
      margin-bottom: 8px;
      color: #fff;
    }
    .subtitle {
      color: #888;
      margin-bottom: 32px;
      font-size: 14px;
    }
    .step {
      background: #141414;
      border: 1px solid #262626;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .step-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }
    .step-number {
      background: #262626;
      color: #888;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 600;
      flex-shrink: 0;
    }
    .step-number.active { background: #3b82f6; color: #fff; }
    .step-title { font-size: 16px; font-weight: 600; color: #fff; }
    label {
      display: block;
      font-size: 13px;
      color: #888;
      margin-bottom: 6px;
      margin-top: 12px;
    }
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
    }
    select:focus, input[type="text"]:focus {
      border-color: #3b82f6;
    }
    .wallet-address {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 12px;
      font-family: monospace;
      font-size: 13px;
      word-break: break-all;
      color: #3b82f6;
      cursor: pointer;
      position: relative;
    }
    .wallet-address:hover { background: #222; }
    .wallet-address::after {
      content: 'Click to copy';
      position: absolute;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 11px;
      color: #666;
      font-family: sans-serif;
    }
    .amount-display {
      text-align: center;
      padding: 16px;
      background: #1a1a1a;
      border-radius: 8px;
      border: 1px solid #333;
    }
    .amount-display .amount {
      font-size: 32px;
      font-weight: 700;
      color: #fff;
    }
    .amount-display .token { color: #888; font-size: 14px; }
    button {
      width: 100%;
      padding: 14px;
      background: #3b82f6;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 16px;
    }
    button:hover { background: #2563eb; }
    button:disabled {
      background: #262626;
      color: #666;
      cursor: not-allowed;
    }
    .status {
      margin-top: 16px;
      padding: 12px;
      border-radius: 8px;
      font-size: 14px;
      display: none;
    }
    .status.pending { background: #1a1500; border: 1px solid #854d0e; color: #fbbf24; display: block; }
    .status.verified { background: #001a00; border: 1px solid #166534; color: #4ade80; display: block; }
    .status.failed { background: #1a0000; border: 1px solid #991b1b; color: #f87171; display: block; }
    .status.error { background: #1a0000; border: 1px solid #991b1b; color: #f87171; display: block; }
    .powered-by {
      text-align: center;
      margin-top: 24px;
      font-size: 12px;
      color: #444;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Pay with Crypto</h1>
    <p class="subtitle" id="userInfo">Loading...</p>

    <!-- Step 1: Choose chain & token -->
    <div class="step">
      <div class="step-header">
        <div class="step-number active">1</div>
        <div class="step-title">Choose payment method</div>
      </div>
      <label>Blockchain</label>
      <select id="chainSelect">
        <option value="base">Base (fastest, lowest fees)</option>
        <option value="eth">Ethereum</option>
        <option value="sol">Solana</option>
        <option value="ton">TON</option>
      </select>
      <label>Token</label>
      <select id="tokenSelect">
        <option value="usdc">USDC</option>
        <option value="usdt">USDT</option>
      </select>
    </div>

    <!-- Step 2: Send payment -->
    <div class="step">
      <div class="step-header">
        <div class="step-number active">2</div>
        <div class="step-title">Send payment</div>
      </div>
      <div class="amount-display">
        <div class="amount" id="amountDisplay">$10.00</div>
        <div class="token" id="tokenDisplay">USDC on Base</div>
      </div>
      <label>Send to this address</label>
      <div class="wallet-address" id="walletAddress" onclick="copyAddress()">Loading...</div>
    </div>

    <!-- Step 3: Submit tx hash -->
    <div class="step">
      <div class="step-header">
        <div class="step-number active">3</div>
        <div class="step-title">Confirm payment</div>
      </div>
      <label>Transaction hash</label>
      <input type="text" id="txHashInput" placeholder="0x... or paste your transaction hash">
      <button id="submitBtn" onclick="submitPayment()">Verify Payment</button>
      <div class="status" id="statusMsg"></div>
    </div>

    <p class="powered-by">Powered by OpenClaw</p>
  </div>

  <script>
    // Read query params
    const params = new URLSearchParams(window.location.search);
    const idType = params.get('idtype') || 'tg';
    const uid = params.get('uid') || '';
    const planParam = params.get('plan') || 'starter';

    let appConfig = null;

    // Init
    async function init() {
      if (!uid) {
        document.getElementById('userInfo').textContent = 'Error: No user ID provided';
        document.getElementById('submitBtn').disabled = true;
        return;
      }

      const label = idType === 'tg' ? 'Telegram ID: ' + uid : uid;
      document.getElementById('userInfo').textContent = 'Paying as ' + label;

      // Fetch config
      const resp = await fetch('/api/config');
      appConfig = await resp.json();
      updateDisplay();
    }

    function updateDisplay() {
      if (!appConfig) return;
      const chain = document.getElementById('chainSelect').value;
      const token = document.getElementById('tokenSelect').value;

      // Update wallet address
      const wallet = appConfig.wallets[chain] || 'Not configured';
      document.getElementById('walletAddress').textContent = wallet;

      // Update amount
      const price = appConfig.prices[planParam] || appConfig.prices.starter;
      document.getElementById('amountDisplay').textContent = '$' + price.toFixed(2);

      const chainNames = { base: 'Base', eth: 'Ethereum', sol: 'Solana', ton: 'TON' };
      document.getElementById('tokenDisplay').textContent =
        token.toUpperCase() + ' on ' + (chainNames[chain] || chain);
    }

    function copyAddress() {
      const addr = document.getElementById('walletAddress').textContent;
      navigator.clipboard.writeText(addr).then(() => {
        const el = document.getElementById('walletAddress');
        const original = el.style.borderColor;
        el.style.borderColor = '#4ade80';
        setTimeout(() => { el.style.borderColor = original; }, 1000);
      });
    }

    async function submitPayment() {
      const txHash = document.getElementById('txHashInput').value.trim();
      if (!txHash) {
        showStatus('error', 'Please enter a transaction hash');
        return;
      }

      const chain = document.getElementById('chainSelect').value;
      const token = document.getElementById('tokenSelect').value;

      showStatus('pending', 'Verifying transaction on-chain...');
      document.getElementById('submitBtn').disabled = true;

      try {
        const resp = await fetch('/api/payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            txHash,
            chainId: chain,
            token,
            idType,
            uid,
          }),
        });

        const data = await resp.json();

        if (resp.ok && data.payment?.status === 'verified') {
          const p = data.payment;
          showStatus('verified',
            'Payment verified! ' +
            (p.plan_id ? p.plan_id.charAt(0).toUpperCase() + p.plan_id.slice(1) + ' plan' : '$' + p.amount_usd) +
            ' — ' + p.amount_usd + ' ' + p.token.toUpperCase() +
            '. You can close this page.');
        } else if (resp.status === 409) {
          showStatus('error', 'This transaction was already submitted.');
        } else {
          showStatus('failed', data.error || 'Verification failed. Please check the transaction hash and try again.');
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

    document.getElementById('chainSelect').addEventListener('change', updateDisplay);
    document.getElementById('tokenSelect').addEventListener('change', updateDisplay);
    init();
  </script>
</body>
</html>`;
}

// ── Start server ─────────────────────────────────────────────────────

console.log(`CryptoPayments server starting on port ${config.port}`);
serve({
  fetch: app.fetch,
  port: config.port,
});
console.log(`CryptoPayments server running at http://localhost:${config.port}`);
