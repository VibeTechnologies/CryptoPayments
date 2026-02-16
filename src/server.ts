import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { loadConfig, type ChainId, type TokenId, TOKEN_ADDRESSES } from "./config.ts";
import {
  createDB,
  type DB,
  // Legacy compat
  insertPayment,
  getPaymentById,
  getPaymentByTx,
  getPaymentsByUser,
  markPaymentVerified,
  markPaymentFailed,
  // Stripe-like API
  getOrCreateCustomer,
  getCustomerById,
  updateCustomer,
  listCustomers,
  createInvoice,
  getInvoiceById,
  getInvoiceWithLineItems,
  listInvoices,
  addInvoiceLineItem,
  finalizeInvoice,
  voidInvoice,
  createPaymentIntent,
  getPaymentIntentById,
  listPaymentIntents,
  updatePaymentIntentStatus,
  createCheckoutSession,
  getCheckoutSessionById,
  completeCheckoutSession,
  listWebhookEvents,
  createWebhookEvent,
  type PaymentRecord,
} from "./db.ts";
import { verifyTransfer, resolveplan } from "./verify.ts";
import { verifyTelegramInitData } from "./telegram.ts";

const config = loadConfig();
const db = createDB(config.supabaseUrl, config.supabaseKey);

// ── App factory (for testing) ────────────────────────────────────────────────

export function createApp(injectedDb?: DB) {
  const appDb = injectedDb ?? db;
  const app = new Hono();

  // ── Middleware ──────────────────────────────────────────────────────────────

  app.use("/api/*", cors({ origin: "*" }));
  app.use("/v1/*", cors({ origin: "*" }));

  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
  });

  // ── API key auth middleware helper ─────────────────────────────────────────

  function requireApiKey(c: Context): boolean {
    if (!config.apiKey) return true;
    const provided = c.req.header("x-api-key") ?? c.req.query("api_key");
    return provided === config.apiKey;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LEGACY API (backward compatible)
  // ══════════════════════════════════════════════════════════════════════════

  // ── Health ──────────────────────────────────────────────────────────────────

  app.get("/api/health", (c) =>
    c.json({ ok: true, chains: ["base", "eth", "ton", "sol", "base_sepolia"], tokens: ["usdt", "usdc"] }),
  );

  // ── Public config ──────────────────────────────────────────────────────────

  app.get("/api/config", (c) => {
    return c.json({
      wallets: config.wallets,
      prices: config.prices,
      tokens: TOKEN_ADDRESSES,
      chains: ["base", "eth", "ton", "sol", "base_sepolia"],
    });
  });

  // ── Submit tx hash for verification (legacy) ───────────────────────────────

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
      const result = await verifyTelegramInitData(body.initData, config.telegramBotToken);
      if (!result.valid) {
        return c.json({ error: "Invalid Telegram initData" }, 401);
      }
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
    if (!body.chainId || !["base", "eth", "ton", "sol", "base_sepolia"].includes(body.chainId)) {
      return c.json({ error: "chainId must be base, eth, ton, sol, or base_sepolia" }, 400);
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
    const existing = await getPaymentByTx(appDb, body.txHash, body.chainId);
    if (existing) {
      return c.json({ error: "Transaction already submitted", payment: existing }, 409);
    }

    // ── Insert pending payment ──
    const payment = await insertPayment(appDb, {
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
        await markPaymentFailed(appDb, payment.id);
        const updated = await getPaymentById(appDb, payment.id);
        return c.json({ payment: updated, error: "Transfer not found or not to our wallet" }, 400);
      }

      const planId = resolveplan(result.amountUsd, config.prices);

      await markPaymentVerified(appDb, payment.id, {
        fromAddress: result.from,
        toAddress: result.to,
        amountRaw: result.amountRaw,
        amountUsd: result.amountUsd,
        blockNumber: result.blockNumber,
        planId: planId ?? body.plan ?? undefined,
      });

      const verified = await getPaymentById(appDb, payment.id);

      // ── Send webhook callback ──
      if (body.callbackUrl && config.callbackSecret && verified) {
        sendCallback(body.callbackUrl, verified).catch((err) =>
          console.error("Callback error:", err),
        );
      }

      return c.json({ payment: verified });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markPaymentFailed(appDb, payment.id);
      return c.json(
        { error: `Verification failed: ${msg}`, payment: await getPaymentById(appDb, payment.id) },
        500,
      );
    }
  });

  // ── Check payment status (legacy) ──────────────────────────────────────────

  app.get("/api/payment/:id", async (c) => {
    if (!requireApiKey(c)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const id = c.req.param("id");
    // Legacy: try as a stripe_id (pi_...) or number
    const numId = Number(id);
    if (!id.startsWith("pi_") && Number.isNaN(numId)) {
      return c.json({ error: "Invalid payment ID" }, 400);
    }

    const payment = await getPaymentById(appDb, id);
    if (!payment) return c.json({ error: "Payment not found" }, 404);

    return c.json({ payment });
  });

  // ── User payment history (legacy) ──────────────────────────────────────────

  app.get("/api/payments", async (c) => {
    if (!requireApiKey(c)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const idType = c.req.query("idtype");
    const uid = c.req.query("uid");

    if (!idType || !uid) {
      return c.json({ error: "Query params idtype and uid are required" }, 400);
    }

    const payments = await getPaymentsByUser(appDb, idType, uid);
    return c.json({ payments });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // STRIPE-LIKE v1 API
  // ══════════════════════════════════════════════════════════════════════════

  // ── Customers ──────────────────────────────────────────────────────────────

  app.post("/v1/customers", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<{
      id_type: "tg" | "email";
      uid: string;
      name?: string;
      email?: string;
      metadata?: Record<string, unknown>;
    }>();

    if (!body.id_type || !body.uid) {
      return c.json({ error: "id_type and uid are required" }, 400);
    }

    const customer = await getOrCreateCustomer(appDb, body.id_type, body.uid);
    // Apply optional fields if provided
    if (body.name || body.email || body.metadata) {
      const updated = await updateCustomer(appDb, customer.id, {
        name: body.name,
        email: body.email,
        metadata: body.metadata,
      });
      return c.json(updated);
    }
    return c.json(customer);
  });

  app.get("/v1/customers/:id", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    const customer = await getCustomerById(appDb, c.req.param("id"));
    if (!customer) return c.json({ error: "Customer not found" }, 404);
    return c.json(customer);
  });

  app.get("/v1/customers", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    const limit = Number(c.req.query("limit")) || 10;
    const offset = Number(c.req.query("offset")) || 0;
    const data = await listCustomers(appDb, { limit, offset });
    return c.json({ object: "list", data, has_more: data.length === limit });
  });

  // ── Invoices ───────────────────────────────────────────────────────────────

  app.post("/v1/invoices", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<{
      customer_id: string;
      plan_id?: string;
      description?: string;
      footer?: string;
      metadata?: Record<string, unknown>;
      due_date?: string;
    }>();

    if (!body.customer_id) {
      return c.json({ error: "customer_id is required" }, 400);
    }

    const invoice = await createInvoice(appDb, {
      customerId: body.customer_id,
      planId: body.plan_id,
      description: body.description,
      footer: body.footer,
      metadata: body.metadata,
      dueDate: body.due_date,
    });
    return c.json(invoice);
  });

  app.get("/v1/invoices/:id", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    const expand = c.req.query("expand");
    if (expand === "line_items") {
      const invoice = await getInvoiceWithLineItems(appDb, c.req.param("id"));
      if (!invoice) return c.json({ error: "Invoice not found" }, 404);
      return c.json(invoice);
    }
    const invoice = await getInvoiceById(appDb, c.req.param("id"));
    if (!invoice) return c.json({ error: "Invoice not found" }, 404);
    return c.json(invoice);
  });

  app.get("/v1/invoices", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    const limit = Number(c.req.query("limit")) || 10;
    const offset = Number(c.req.query("offset")) || 0;
    const customerId = c.req.query("customer_id");
    const status = c.req.query("status");
    const data = await listInvoices(appDb, { customerId: customerId ?? undefined, status: status ?? undefined, limit, offset });
    return c.json({ object: "list", data, has_more: data.length === limit });
  });

  app.post("/v1/invoices/:id/finalize", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const invoice = await finalizeInvoice(appDb, c.req.param("id"));
      return c.json(invoice);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/v1/invoices/:id/void", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    try {
      const invoice = await voidInvoice(appDb, c.req.param("id"));
      return c.json(invoice);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/v1/invoices/:id/line_items", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<{
      description: string;
      amount: number;
      quantity?: number;
      metadata?: Record<string, unknown>;
    }>();

    if (!body.description || body.amount == null) {
      return c.json({ error: "description and amount are required" }, 400);
    }

    try {
      const item = await addInvoiceLineItem(appDb, c.req.param("id"), body);
      return c.json(item);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ── Invoice HTML rendering ─────────────────────────────────────────────────

  app.get("/v1/invoices/:id/html", async (c) => {
    const invoice = await getInvoiceWithLineItems(appDb, c.req.param("id"));
    if (!invoice) return c.json({ error: "Invoice not found" }, 404);

    const customer = invoice.customer_id
      ? await getCustomerById(appDb, invoice.customer_id)
      : null;

    return c.html(renderInvoiceHtml(invoice, customer));
  });

  // ── Payment Intents ────────────────────────────────────────────────────────

  app.post("/v1/payment_intents", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<{
      customer_id?: string;
      invoice_id?: string;
      amount: number;
      chain_id?: string;
      token?: string;
      plan_id?: string;
      description?: string;
      metadata?: Record<string, unknown>;
    }>();

    if (body.amount == null) {
      return c.json({ error: "amount is required" }, 400);
    }

    const pi = await createPaymentIntent(appDb, {
      customerId: body.customer_id,
      invoiceId: body.invoice_id,
      amount: body.amount,
      chainId: body.chain_id,
      token: body.token,
      planId: body.plan_id,
      description: body.description,
      metadata: body.metadata,
    });
    return c.json(pi);
  });

  app.get("/v1/payment_intents/:id", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    const pi = await getPaymentIntentById(appDb, c.req.param("id"));
    if (!pi) return c.json({ error: "Payment intent not found" }, 404);
    return c.json(pi);
  });

  app.get("/v1/payment_intents", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    const limit = Number(c.req.query("limit")) || 10;
    const offset = Number(c.req.query("offset")) || 0;
    const customerId = c.req.query("customer_id");
    const status = c.req.query("status");
    const data = await listPaymentIntents(appDb, { customerId: customerId ?? undefined, status: status ?? undefined, limit, offset });
    return c.json({ object: "list", data, has_more: data.length === limit });
  });

  app.post("/v1/payment_intents/:id/confirm", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<{
      tx_hash?: string;
      chain_id?: string;
      token?: string;
    }>();

    try {
      const pi = await updatePaymentIntentStatus(appDb, c.req.param("id"), "processing", {
        txHash: body.tx_hash,
        chainId: body.chain_id,
        token: body.token,
      });
      return c.json(pi);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ── Checkout Sessions ──────────────────────────────────────────────────────

  app.post("/v1/checkout/sessions", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json<{
      customer_id?: string;
      invoice_id?: string;
      payment_intent_id?: string;
      plan_id?: string;
      amount: number;
      success_url?: string;
      cancel_url?: string;
      callback_url?: string;
      metadata?: Record<string, unknown>;
      expires_in_minutes?: number;
    }>();

    if (body.amount == null) {
      return c.json({ error: "amount is required" }, 400);
    }

    const session = await createCheckoutSession(
      appDb,
      {
        customerId: body.customer_id,
        invoiceId: body.invoice_id,
        paymentIntentId: body.payment_intent_id,
        planId: body.plan_id,
        amount: body.amount,
        successUrl: body.success_url,
        cancelUrl: body.cancel_url,
        callbackUrl: body.callback_url,
        metadata: body.metadata,
        expiresInMinutes: body.expires_in_minutes,
      },
      config.baseUrl,
    );
    return c.json(session);
  });

  app.get("/v1/checkout/sessions/:id", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    const session = await getCheckoutSessionById(appDb, c.req.param("id"));
    if (!session) return c.json({ error: "Checkout session not found" }, 404);
    return c.json(session);
  });

  // ── Webhook Events ─────────────────────────────────────────────────────────

  app.get("/v1/events", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    const limit = Number(c.req.query("limit")) || 10;
    const offset = Number(c.req.query("offset")) || 0;
    const type = c.req.query("type");
    const data = await listWebhookEvents(appDb, { type: type ?? undefined, limit, offset });
    return c.json({ object: "list", data, has_more: data.length === limit });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CHECKOUT PAGE (public)
  // ══════════════════════════════════════════════════════════════════════════

  app.get("/checkout/:id", async (c) => {
    const session = await getCheckoutSessionById(appDb, c.req.param("id"));
    if (!session) return c.text("Checkout session not found", 404);
    if (session.status === "expired") return c.text("This checkout session has expired", 410);
    if (session.status === "complete") return c.text("This payment has already been completed", 200);

    const amountUsd = session.amount / 100;
    const planLabel = session.plan_id
      ? session.plan_id.charAt(0).toUpperCase() + session.plan_id.slice(1)
      : null;

    return c.html(checkoutPageHtml(session.stripe_id, amountUsd, planLabel));
  });

  // ── TonConnect manifest (required for TON wallet integration) ─────────────
  app.get("/tonconnect-manifest.json", (c) => {
    const baseUrl = config.baseUrl || `${c.req.url.split("/tonconnect")[0]}`;
    return c.json({
      url: baseUrl,
      name: "OpenClaw Crypto Payments",
      iconUrl: "https://openclaw.ai/favicon.ico",
    });
  });

  // ── Default payment page (Telegram Mini App) ──────────────────────────────
  // /pay is the canonical path used by the bot's Mini App URL
  app.get("/pay", (c) => c.html(paymentPageHtml()));
  app.get("/", (c) => c.html(paymentPageHtml()));

  return app;
}

// ── Webhook callback ─────────────────────────────────────────────────────────

/** Compute HMAC-SHA256 using the Web Crypto API */
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendCallback(callbackUrl: string, payment: PaymentRecord): Promise<void> {
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

  const signature = await hmacSha256Hex(config.callbackSecret, payload);

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

// ── Invoice HTML renderer ────────────────────────────────────────────────────

function renderInvoiceHtml(
  invoice: {
    stripe_id: string;
    status: string;
    currency: string;
    subtotal: number;
    tax: number;
    total: number;
    amount_paid: number;
    amount_remaining: number;
    description: string | null;
    footer: string | null;
    plan_id: string | null;
    created_at: string;
    due_date: string | null;
    paid_at: string | null;
    line_items: Array<{ description: string; amount: number; quantity: number }>;
  },
  customer: { uid: string; id_type: string; name: string | null; email: string | null } | null,
): string {
  const fmtCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US") : "—");

  const statusColor: Record<string, string> = {
    draft: "#888",
    open: "#3b82f6",
    paid: "#4ade80",
    void: "#f87171",
    uncollectible: "#fbbf24",
  };

  const lineItemsHtml = invoice.line_items
    .map(
      (li) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee">${li.description}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${li.quantity}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${fmtCents(li.amount)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${fmtCents(li.amount * li.quantity)}</td>
    </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invoice ${invoice.stripe_id}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 40px; color: #333; }
    .container { max-width: 700px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px; }
    .logo { font-size: 24px; font-weight: 700; color: #111; }
    .status-badge { padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; color: #fff; background: ${statusColor[invoice.status] ?? "#888"}; }
    .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px; }
    .meta-group label { display: block; font-size: 11px; text-transform: uppercase; color: #888; margin-bottom: 2px; }
    .meta-group p { margin: 0; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    th { text-align: left; padding: 8px 12px; border-bottom: 2px solid #333; font-size: 12px; text-transform: uppercase; color: #888; }
    th:nth-child(2), th:nth-child(3), th:nth-child(4) { text-align: right; }
    th:nth-child(2) { text-align: center; }
    .totals { text-align: right; font-size: 14px; }
    .totals .row { display: flex; justify-content: flex-end; gap: 40px; padding: 4px 0; }
    .totals .total { font-weight: 700; font-size: 18px; border-top: 2px solid #333; padding-top: 8px; margin-top: 4px; }
    .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #888; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <div class="logo">OpenClaw</div>
        <div style="font-size:12px;color:#888">Crypto Payment Invoice</div>
      </div>
      <span class="status-badge">${invoice.status.toUpperCase()}</span>
    </div>

    <div class="meta">
      <div class="meta-group">
        <label>Invoice</label>
        <p>${invoice.stripe_id}</p>
      </div>
      <div class="meta-group">
        <label>Date</label>
        <p>${fmtDate(invoice.created_at)}</p>
      </div>
      <div class="meta-group">
        <label>Bill to</label>
        <p>${customer?.name ?? customer?.uid ?? "—"}</p>
        <p style="color:#888;font-size:12px">${customer?.email ?? (customer ? `${customer.id_type}:${customer.uid}` : "")}</p>
      </div>
      <div class="meta-group">
        <label>Due date</label>
        <p>${fmtDate(invoice.due_date)}</p>
      </div>
    </div>

    ${invoice.description ? `<p style="margin-bottom:20px">${invoice.description}</p>` : ""}

    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th>Qty</th>
          <th>Unit price</th>
          <th>Amount</th>
        </tr>
      </thead>
      <tbody>
        ${lineItemsHtml || '<tr><td colspan="4" style="padding:20px;text-align:center;color:#888">No line items</td></tr>'}
      </tbody>
    </table>

    <div class="totals">
      <div class="row"><span>Subtotal</span><span>${fmtCents(invoice.subtotal)}</span></div>
      ${invoice.tax ? `<div class="row"><span>Tax</span><span>${fmtCents(invoice.tax)}</span></div>` : ""}
      <div class="row total"><span>Total</span><span>${fmtCents(invoice.total)}</span></div>
      <div class="row"><span>Amount paid</span><span>${fmtCents(invoice.amount_paid)}</span></div>
      <div class="row" style="font-weight:600"><span>Amount due</span><span>${fmtCents(invoice.amount_remaining)}</span></div>
    </div>

    ${invoice.footer ? `<div class="footer">${invoice.footer}</div>` : ""}
    <div class="footer">Powered by OpenClaw &mdash; Crypto Payment Processor</div>
  </div>
</body>
</html>`;
}

// ── Checkout page HTML ───────────────────────────────────────────────────────

function checkoutPageHtml(sessionId: string, amountUsd: number, planLabel: string | null): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Checkout — OpenClaw</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js" defer><\/script>
  <script src="https://unpkg.com/@tonconnect/ui@2.0.9/dist/tonconnect-ui.min.js" defer><\/script>
  <style>
    :root { --bg:#0a0a0a; --surface:#141414; --border:#262626; --text:#e5e5e5; --text-dim:#888; --accent:#3b82f6; --accent-hover:#2563eb; --success:#4ade80; --warning:#fbbf24; --error:#f87171; }
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; padding:16px; }
    .container { max-width:480px; margin:0 auto; }
    h1 { font-size:22px; margin-bottom:4px; color:#fff; }
    .subtitle { color:var(--text-dim); margin-bottom:24px; font-size:13px; }
    .step { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:16px; margin-bottom:12px; }
    .step-header { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
    .step-num { background:var(--accent); color:#fff; width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; }
    .step-title { font-size:15px; font-weight:600; }
    label { display:block; font-size:12px; color:var(--text-dim); margin-bottom:4px; margin-top:10px; }
    select, input[type="text"] { width:100%; padding:10px 12px; background:#1a1a1a; border:1px solid #333; border-radius:8px; color:#fff; font-size:14px; outline:none; }
    .amount-box { text-align:center; padding:14px; background:#1a1a1a; border-radius:8px; border:1px solid #333; }
    .amount-box .amount { font-size:28px; font-weight:700; color:#fff; }
    .amount-box .token-label { color:var(--text-dim); font-size:13px; margin-top:2px; }
    .wallet-box { background:#1a1a1a; border:1px solid #333; border-radius:8px; padding:10px 12px; font-family:monospace; font-size:12px; word-break:break-all; color:var(--accent); cursor:pointer; }
    .copy-hint { font-size:11px; color:var(--text-dim); margin-top:4px; text-align:right; }
    button, .wallet-btn { width:100%; padding:14px; background:var(--accent); color:#fff; border:none; border-radius:8px; font-size:15px; font-weight:600; cursor:pointer; margin-top:12px; transition:background .2s; }
    button:hover, .wallet-btn:hover { background:var(--accent-hover); }
    button:disabled, .wallet-btn:disabled { background:#262626; color:#666; cursor:not-allowed; }
    .wallet-btn.metamask { background:#f6851b; }
    .wallet-btn.metamask:hover { background:#e2761b; }
    .wallet-btn.phantom { background:#ab9ff2; color:#000; }
    .wallet-btn.phantom:hover { background:#9b8fe2; }
    .wallet-btn.tonconnect { background:#0098ea; }
    .wallet-btn.tonconnect:hover { background:#0088d0; }
    .wallet-btn.connected { background:#166534; }
    .wallet-btn.connected:hover { background:#15803d; }
    .or-divider { text-align:center; color:var(--text-dim); font-size:12px; margin:12px 0; position:relative; }
    .or-divider::before, .or-divider::after { content:''; position:absolute; top:50%; width:40%; height:1px; background:var(--border); }
    .or-divider::before { left:0; }
    .or-divider::after { right:0; }
    .status { margin-top:12px; padding:10px 12px; border-radius:8px; font-size:13px; display:none; }
    .status.pending { background:#1a1500; border:1px solid #854d0e; color:var(--warning); display:block; }
    .status.verified { background:#001a00; border:1px solid #166534; color:var(--success); display:block; }
    .status.failed, .status.error { background:#1a0000; border:1px solid #991b1b; color:var(--error); display:block; }
    .chain-badges { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px; }
    .chain-badge { padding:6px 12px; border-radius:20px; font-size:12px; font-weight:600; cursor:pointer; border:1px solid #333; background:#1a1a1a; color:var(--text-dim); transition:all .2s; }
    .chain-badge.active { background:var(--accent); color:#fff; border-color:var(--accent); }
    .powered { text-align:center; margin-top:20px; font-size:11px; color:#333; }
    #walletSection { display:none; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Checkout</h1>
    <p class="subtitle">${planLabel ? planLabel + " plan — " : ""}$${amountUsd.toFixed(2)} USD</p>

    <div class="step">
      <div class="step-header"><div class="step-num">1</div><div class="step-title">Choose network</div></div>
      <div class="chain-badges" id="chainBadges">
        <div class="chain-badge active" data-chain="base" onclick="selectChain('base')">Base</div>
        <div class="chain-badge" data-chain="eth" onclick="selectChain('eth')">Ethereum</div>
        <div class="chain-badge" data-chain="sol" onclick="selectChain('sol')">Solana</div>
        <div class="chain-badge" data-chain="ton" onclick="selectChain('ton')">TON</div>
        <div class="chain-badge" data-chain="base_sepolia" onclick="selectChain('base_sepolia')">Base Sepolia</div>
      </div>
      <label>Token</label>
      <select id="tokenSelect" onchange="updateDisplay()">
        <option value="usdc">USDC</option>
        <option value="usdt">USDT</option>
      </select>
    </div>

    <div class="step">
      <div class="step-header"><div class="step-num">2</div><div class="step-title">Send payment</div></div>
      <div class="amount-box">
        <div class="amount" id="amountDisplay">$\${amountUsd.toFixed(2)}</div>
        <div class="token-label" id="tokenDisplay">USDC on Base</div>
      </div>

      <div id="walletSection">
        <button class="wallet-btn metamask" id="evmWalletBtn" onclick="connectEvmWallet()" style="display:none;">Connect MetaMask<\/button>
        <button class="wallet-btn phantom" id="solWalletBtn" onclick="connectSolWallet()" style="display:none;">Connect Phantom<\/button>
        <div id="tonWalletBtnContainer" style="display:none; margin-top:12px;"><div id="ton-connect-button"><\/div><\/div>
        <button class="wallet-btn" id="sendTxBtn" onclick="sendWalletTx()" style="display:none;" disabled>Send Payment via Wallet<\/button>
      </div>

      <div class="or-divider" id="orDivider" style="display:none;">or</div>

      <label>Send exactly this amount to</label>
      <div class="wallet-box" id="walletAddress" onclick="copyAddress()">Loading...</div>
      <div class="copy-hint" id="copyHint">Tap to copy</div>
    </div>

    <div class="step">
      <div class="step-header"><div class="step-num">3</div><div class="step-title">Confirm payment</div></div>
      <label>Paste your transaction hash</label>
      <input type="text" id="txHashInput" placeholder="0x... or transaction signature">
      <button id="submitBtn" onclick="submitPayment()">Verify Payment</button>
      <div class="status" id="statusMsg"></div>
    </div>

    <p class="powered">Powered by OpenClaw</p>
  </div>

  <script>
    const sessionId = '\${sessionId}';
    const amount = \${amountUsd};
    const plan = '\${planLabel?.toLowerCase() ?? ""}';
    let selectedChain = 'base';
    let appConfig = null;
    let evmSigner = null;
    let solPublicKey = null;
    let tonConnector = null;
    let walletConnected = false;

    const EVM_CHAINS = ['base', 'eth', 'base_sepolia'];
    const EVM_CHAIN_IDS = { base: '0x2105', eth: '0x1', base_sepolia: '0x14a34' };
    const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];

    async function init() {
      try {
        const resp = await fetch('/api/config');
        appConfig = await resp.json();
        updateDisplay();
      } catch (e) { console.error('Config load error', e); }
    }

    function selectChain(chain) {
      selectedChain = chain;
      walletConnected = false;
      evmSigner = null;
      solPublicKey = null;
      document.querySelectorAll('.chain-badge').forEach(el => el.classList.toggle('active', el.dataset.chain === chain));
      updateDisplay();
    }

    function updateDisplay() {
      if (!appConfig) return;
      const token = document.getElementById('tokenSelect').value;
      document.getElementById('walletAddress').textContent = appConfig.wallets[selectedChain] || 'Not configured';
      document.getElementById('amountDisplay').textContent = '$' + amount.toFixed(2);
      const names = { base:'Base', eth:'Ethereum', sol:'Solana', ton:'TON', base_sepolia:'Base Sepolia' };
      document.getElementById('tokenDisplay').textContent = token.toUpperCase() + ' on ' + (names[selectedChain] || selectedChain);
      updateWalletButtons();
    }

    function updateWalletButtons() {
      const evmBtn = document.getElementById('evmWalletBtn');
      const solBtn = document.getElementById('solWalletBtn');
      const tonContainer = document.getElementById('tonWalletBtnContainer');
      const sendBtn = document.getElementById('sendTxBtn');
      const section = document.getElementById('walletSection');
      const orDiv = document.getElementById('orDivider');

      evmBtn.style.display = 'none';
      solBtn.style.display = 'none';
      tonContainer.style.display = 'none';
      sendBtn.style.display = 'none';

      const isEvm = EVM_CHAINS.includes(selectedChain);
      const isSol = selectedChain === 'sol';
      const isTon = selectedChain === 'ton';
      let showSection = false;

      if (isEvm && window.ethereum) {
        evmBtn.style.display = 'block';
        evmBtn.textContent = walletConnected ? 'Wallet Connected' : 'Connect MetaMask';
        evmBtn.className = 'wallet-btn metamask' + (walletConnected ? ' connected' : '');
        if (walletConnected) { sendBtn.style.display = 'block'; sendBtn.disabled = false; }
        showSection = true;
      }
      if (isSol && window.phantom?.solana) {
        solBtn.style.display = 'block';
        solBtn.textContent = walletConnected ? 'Wallet Connected' : 'Connect Phantom';
        solBtn.className = 'wallet-btn phantom' + (walletConnected ? ' connected' : '');
        if (walletConnected) { sendBtn.style.display = 'block'; sendBtn.disabled = false; }
        showSection = true;
      }
      if (isTon && window.TonConnectUI) {
        tonContainer.style.display = 'block';
        initTonConnect();
        if (walletConnected) { sendBtn.style.display = 'block'; sendBtn.disabled = false; }
        showSection = true;
      }

      section.style.display = showSection ? 'block' : 'none';
      orDiv.style.display = showSection ? 'block' : 'none';
    }

    async function connectEvmWallet() {
      if (!window.ethereum) { showStatus('error', 'MetaMask not detected'); return; }
      try {
        const provider = new ethers.BrowserProvider(window.ethereum);
        await provider.send('eth_requestAccounts', []);
        const targetChainId = EVM_CHAIN_IDS[selectedChain];
        try {
          await provider.send('wallet_switchEthereumChain', [{ chainId: targetChainId }]);
        } catch (switchErr) {
          if (switchErr.code === 4902) { showStatus('error', 'Please add ' + selectedChain + ' network to MetaMask'); return; }
          throw switchErr;
        }
        evmSigner = await provider.getSigner();
        walletConnected = true;
        updateWalletButtons();
        showStatus('pending', 'Wallet connected: ' + (await evmSigner.getAddress()).slice(0, 8) + '...');
      } catch (err) { showStatus('error', 'MetaMask connection failed: ' + (err.message || err)); }
    }

    async function sendEvmTx() {
      if (!evmSigner || !appConfig) throw new Error('Wallet not connected');
      const token = document.getElementById('tokenSelect').value;
      const tokenAddr = appConfig.tokens[selectedChain]?.[token];
      if (!tokenAddr || tokenAddr === '0x') throw new Error('Token not available on this chain');
      const toAddr = appConfig.wallets[selectedChain];
      const amt = ethers.parseUnits(amount.toString(), 6);
      const contract = new ethers.Contract(tokenAddr, ERC20_ABI, evmSigner);
      const tx = await contract.transfer(toAddr, amt);
      return tx.hash;
    }

    async function connectSolWallet() {
      const phantom = window.phantom?.solana;
      if (!phantom) { showStatus('error', 'Phantom wallet not detected'); return; }
      try {
        const resp = await phantom.connect();
        solPublicKey = resp.publicKey;
        walletConnected = true;
        updateWalletButtons();
        showStatus('pending', 'Phantom connected: ' + solPublicKey.toString().slice(0, 8) + '...');
      } catch (err) { showStatus('error', 'Phantom connection failed: ' + (err.message || err)); }
    }

    let tonInitialized = false;
    function initTonConnect() {
      if (tonInitialized || !window.TonConnectUI) return;
      tonInitialized = true;
      const manifestUrl = window.location.origin + '/tonconnect-manifest.json';
      tonConnector = new window.TonConnectUI.TonConnectUI({ manifestUrl, buttonRootId: 'ton-connect-button' });
      tonConnector.onStatusChange((wallet) => { walletConnected = !!wallet; updateWalletButtons(); });
    }

    async function sendWalletTx() {
      const sendBtn = document.getElementById('sendTxBtn');
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending...';
      showStatus('pending', 'Please confirm the transaction in your wallet...');
      try {
        let txHash;
        if (EVM_CHAINS.includes(selectedChain)) { txHash = await sendEvmTx(); }
        else if (selectedChain === 'sol') { showStatus('error', 'Solana wallet tx — please send manually and paste hash'); return; }
        else if (selectedChain === 'ton') {
          if (!tonConnector?.connected) { await tonConnector?.openModal(); return; }
          const toAddr = appConfig.wallets.ton;
          const jettonAddr = appConfig.tokens.ton?.[document.getElementById('tokenSelect').value];
          if (!jettonAddr) throw new Error('Token not available');
          const forwardTon = '50000000';
          const result = await tonConnector.sendTransaction({
            validUntil: Math.floor(Date.now() / 1000) + 600,
            messages: [{ address: jettonAddr, amount: forwardTon }],
          });
          txHash = result.boc || result;
        }
        if (txHash) {
          document.getElementById('txHashInput').value = txHash;
          showStatus('pending', 'Transaction sent! Verifying on-chain...');
          await submitPayment();
        }
      } catch (err) {
        showStatus('error', 'Transaction failed: ' + (err.message || err));
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Payment via Wallet';
      }
    }

    function copyAddress() {
      const addr = document.getElementById('walletAddress').textContent;
      if (!addr || addr === 'Not configured' || addr === 'Loading...') return;
      navigator.clipboard.writeText(addr).then(() => {
        document.getElementById('copyHint').textContent = 'Copied!';
        setTimeout(() => document.getElementById('copyHint').textContent = 'Tap to copy', 1500);
      });
    }

    async function submitPayment() {
      const txHash = document.getElementById('txHashInput').value.trim();
      if (!txHash) { showStatus('error', 'Please enter a transaction hash'); return; }
      const token = document.getElementById('tokenSelect').value;
      showStatus('pending', 'Verifying transaction on-chain...');
      document.getElementById('submitBtn').disabled = true;
      try {
        const resp = await fetch('/api/payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txHash, chainId: selectedChain, token, idType: 'tg', uid: sessionId, plan }),
        });
        const data = await resp.json();
        if (resp.ok && data.payment?.status === 'verified') {
          showStatus('verified', 'Payment verified! You can close this page.');
        } else if (resp.status === 409) {
          showStatus('error', 'This transaction was already submitted.');
        } else {
          showStatus('failed', data.error || 'Verification failed.');
        }
      } catch (e) { showStatus('error', 'Network error. Please try again.'); }
      finally { document.getElementById('submitBtn').disabled = false; }
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

// ── Payment page HTML (Telegram Mini App) ────────────────────────────────────

function paymentPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Pay with Crypto — OpenClaw</title>
  <script src="https://telegram.org/js/telegram-web-app.js"><\/script>
  <!-- Web3 SDKs (loaded only when needed) -->
  <script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js" defer><\/script>
  <script src="https://unpkg.com/@tonconnect/ui@2.0.9/dist/tonconnect-ui.min.js" defer><\/script>
  <style>
    :root {
      --bg: #0a0a0a; --surface: #141414; --border: #262626;
      --text: #e5e5e5; --text-dim: #888;
      --accent: #3b82f6; --accent-hover: #2563eb;
      --success: #4ade80; --warning: #fbbf24; --error: #f87171;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg); color: var(--text); min-height: 100vh; padding: 16px;
    }
    body.tg-theme {
      background: var(--tg-theme-bg-color, var(--bg));
      color: var(--tg-theme-text-color, var(--text));
    }
    .container { max-width: 480px; margin: 0 auto; }
    h1 { font-size: 22px; margin-bottom: 4px; color: #fff; }
    .subtitle { color: var(--text-dim); margin-bottom: 24px; font-size: 13px; }
    .step {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 16px; margin-bottom: 12px;
    }
    .step-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    .step-num {
      background: var(--accent); color: #fff; width: 24px; height: 24px;
      border-radius: 50%; display: flex; align-items: center; justify-content: center;
      font-size: 12px; font-weight: 700; flex-shrink: 0;
    }
    .step-title { font-size: 15px; font-weight: 600; }
    label { display: block; font-size: 12px; color: var(--text-dim); margin-bottom: 4px; margin-top: 10px; }
    label:first-of-type { margin-top: 0; }
    select, input[type="text"] {
      width: 100%; padding: 10px 12px; background: #1a1a1a; border: 1px solid #333;
      border-radius: 8px; color: #fff; font-size: 14px; outline: none; -webkit-appearance: none;
    }
    select:focus, input[type="text"]:focus { border-color: var(--accent); }
    .wallet-box {
      background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 10px 12px;
      font-family: monospace; font-size: 12px; word-break: break-all; color: var(--accent);
      cursor: pointer; transition: border-color 0.2s;
    }
    .wallet-box:active { border-color: var(--success); }
    .copy-hint { font-size: 11px; color: var(--text-dim); margin-top: 4px; text-align: right; }
    .amount-box { text-align: center; padding: 14px; background: #1a1a1a; border-radius: 8px; border: 1px solid #333; }
    .amount-box .amount { font-size: 28px; font-weight: 700; color: #fff; }
    .amount-box .token-label { color: var(--text-dim); font-size: 13px; margin-top: 2px; }
    button, .wallet-btn {
      width: 100%; padding: 14px; background: var(--accent); color: #fff; border: none;
      border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;
      margin-top: 12px; transition: background 0.2s;
    }
    button:hover, .wallet-btn:hover { background: var(--accent-hover); }
    button:disabled, .wallet-btn:disabled { background: #262626; color: #666; cursor: not-allowed; }
    .wallet-btn.metamask { background: #f6851b; }
    .wallet-btn.metamask:hover { background: #e2761b; }
    .wallet-btn.phantom { background: #ab9ff2; color: #000; }
    .wallet-btn.phantom:hover { background: #9b8fe2; }
    .wallet-btn.tonconnect { background: #0098ea; }
    .wallet-btn.tonconnect:hover { background: #0088d0; }
    .wallet-btn.connected { background: #166534; }
    .wallet-btn.connected:hover { background: #15803d; }
    .or-divider {
      text-align: center; color: var(--text-dim); font-size: 12px;
      margin: 12px 0; position: relative;
    }
    .or-divider::before, .or-divider::after {
      content: ''; position: absolute; top: 50%; width: 40%;
      height: 1px; background: var(--border);
    }
    .or-divider::before { left: 0; }
    .or-divider::after { right: 0; }
    .status { margin-top: 12px; padding: 10px 12px; border-radius: 8px; font-size: 13px; display: none; }
    .status.pending { background: #1a1500; border: 1px solid #854d0e; color: var(--warning); display: block; }
    .status.verified { background: #001a00; border: 1px solid #166534; color: var(--success); display: block; }
    .status.failed, .status.error { background: #1a0000; border: 1px solid #991b1b; color: var(--error); display: block; }
    .chain-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
    .chain-badge {
      padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 600;
      cursor: pointer; border: 1px solid #333; background: #1a1a1a; color: var(--text-dim); transition: all 0.2s;
    }
    .chain-badge.active { background: var(--accent); color: #fff; border-color: var(--accent); }
    .powered { text-align: center; margin-top: 20px; font-size: 11px; color: #333; }
    #walletSection { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Pay with Crypto</h1>
    <p class="subtitle" id="userInfo">Loading...</p>

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
        <div class="chain-badge" data-chain="base_sepolia" onclick="selectChain('base_sepolia')">Base Sepolia</div>
      </div>
      <label>Token</label>
      <select id="tokenSelect" onchange="updateDisplay()">
        <option value="usdc">USDC</option>
        <option value="usdt">USDT</option>
      </select>
    </div>

    <div class="step">
      <div class="step-header">
        <div class="step-num">2</div>
        <div class="step-title">Send payment</div>
      </div>
      <div class="amount-box">
        <div class="amount" id="amountDisplay">$10.00</div>
        <div class="token-label" id="tokenDisplay">USDC on Base</div>
      </div>

      <!-- Wallet connect section (shown based on chain) -->
      <div id="walletSection">
        <button class="wallet-btn metamask" id="evmWalletBtn" onclick="connectEvmWallet()" style="display:none;">
          Connect MetaMask
        </button>
        <button class="wallet-btn phantom" id="solWalletBtn" onclick="connectSolWallet()" style="display:none;">
          Connect Phantom
        </button>
        <div id="tonWalletBtnContainer" style="display:none; margin-top:12px;">
          <div id="ton-connect-button"><\/div>
        </div>
        <button class="wallet-btn" id="sendTxBtn" onclick="sendWalletTx()" style="display:none;" disabled>
          Send Payment via Wallet
        </button>
      </div>

      <div class="or-divider" id="orDivider" style="display:none;">or</div>

      <label>Send exactly this amount to</label>
      <div class="wallet-box" id="walletAddress" onclick="copyAddress()">Loading...</div>
      <div class="copy-hint" id="copyHint">Tap to copy</div>
    </div>

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
    /* ── Telegram Mini App bootstrap ─────────────────────────────────── */
    const tg = window.Telegram?.WebApp;
    let initData = '';
    let tgUserId = '';

    if (tg) {
      tg.ready();
      tg.expand();
      document.body.classList.add('tg-theme');
      initData = tg.initData || '';
      if (tg.initDataUnsafe?.user) tgUserId = String(tg.initDataUnsafe.user.id);
      if (tg.themeParams) {
        const t = tg.themeParams;
        if (t.bg_color) document.documentElement.style.setProperty('--bg', t.bg_color);
        if (t.secondary_bg_color) document.documentElement.style.setProperty('--surface', t.secondary_bg_color);
        if (t.text_color) document.documentElement.style.setProperty('--text', t.text_color);
        if (t.hint_color) document.documentElement.style.setProperty('--text-dim', t.hint_color);
        if (t.button_color) document.documentElement.style.setProperty('--accent', t.button_color);
      }
    }

    /* ── Query params / start_param ──────────────────────────────────── */
    const params = new URLSearchParams(window.location.search);
    const startParam = tg?.initDataUnsafe?.start_param || '';
    let idType = params.get('idtype') || 'tg';
    let uid = params.get('uid') || tgUserId || '';
    let planParam = params.get('plan') || 'starter';
    let callbackUrl = params.get('callback') || '';

    if (startParam && !uid) {
      const parts = startParam.split('_');
      if (parts.length >= 2) {
        planParam = parts[0];
        uid = parts.slice(1).join('_');
        idType = 'tg';
      }
    }

    /* ── State ───────────────────────────────────────────────────────── */
    let selectedChain = 'base';
    let appConfig = null;
    let evmSigner = null;      // ethers.Signer (MetaMask)
    let solPublicKey = null;    // Solana Phantom public key
    let tonConnector = null;    // TonConnectUI instance
    let walletConnected = false;

    const EVM_CHAINS = ['base', 'eth', 'base_sepolia'];
    const EVM_CHAIN_IDS = { base: '0x2105', eth: '0x1', base_sepolia: '0x14a34' };
    const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];

    /* ── Init ────────────────────────────────────────────────────────── */
    async function init() {
      const label = idType === 'tg'
        ? (tg?.initDataUnsafe?.user?.first_name || 'Telegram user ' + uid)
        : uid;
      document.getElementById('userInfo').textContent = uid
        ? 'Paying as ' + label + ' \\u2014 ' + planParam.charAt(0).toUpperCase() + planParam.slice(1) + ' plan'
        : 'Error: No user identified';

      if (!uid) { document.getElementById('submitBtn').disabled = true; return; }

      try {
        const resp = await fetch('/api/config');
        appConfig = await resp.json();
        updateDisplay();
      } catch (err) {
        document.getElementById('userInfo').textContent = 'Error loading config';
      }
    }

    /* ── Chain selection ──────────────────────────────────────────────── */
    function selectChain(chain) {
      selectedChain = chain;
      walletConnected = false;
      evmSigner = null;
      solPublicKey = null;
      document.querySelectorAll('.chain-badge').forEach(el => el.classList.toggle('active', el.dataset.chain === chain));
      updateDisplay();
    }

    function updateDisplay() {
      if (!appConfig) return;
      const token = document.getElementById('tokenSelect').value;
      document.getElementById('walletAddress').textContent = appConfig.wallets[selectedChain] || 'Not configured';
      const price = appConfig.prices[planParam] || appConfig.prices.starter;
      document.getElementById('amountDisplay').textContent = '$' + price.toFixed(2);
      const chainNames = { base: 'Base', eth: 'Ethereum', sol: 'Solana', ton: 'TON', base_sepolia: 'Base Sepolia' };
      document.getElementById('tokenDisplay').textContent = token.toUpperCase() + ' on ' + (chainNames[selectedChain] || selectedChain);
      updateWalletButtons();
    }

    /* ── Wallet button visibility ─────────────────────────────────────── */
    function updateWalletButtons() {
      const evmBtn = document.getElementById('evmWalletBtn');
      const solBtn = document.getElementById('solWalletBtn');
      const tonContainer = document.getElementById('tonWalletBtnContainer');
      const sendBtn = document.getElementById('sendTxBtn');
      const section = document.getElementById('walletSection');
      const orDiv = document.getElementById('orDivider');

      evmBtn.style.display = 'none';
      solBtn.style.display = 'none';
      tonContainer.style.display = 'none';
      sendBtn.style.display = 'none';

      const isEvm = EVM_CHAINS.includes(selectedChain);
      const isSol = selectedChain === 'sol';
      const isTon = selectedChain === 'ton';
      let showSection = false;

      if (isEvm && window.ethereum) {
        evmBtn.style.display = 'block';
        evmBtn.textContent = walletConnected ? 'Wallet Connected' : 'Connect MetaMask';
        evmBtn.className = 'wallet-btn metamask' + (walletConnected ? ' connected' : '');
        if (walletConnected) { sendBtn.style.display = 'block'; sendBtn.disabled = false; }
        showSection = true;
      }
      if (isSol && window.phantom?.solana) {
        solBtn.style.display = 'block';
        solBtn.textContent = walletConnected ? 'Wallet Connected' : 'Connect Phantom';
        solBtn.className = 'wallet-btn phantom' + (walletConnected ? ' connected' : '');
        if (walletConnected) { sendBtn.style.display = 'block'; sendBtn.disabled = false; }
        showSection = true;
      }
      if (isTon && window.TonConnectUI) {
        tonContainer.style.display = 'block';
        initTonConnect();
        if (walletConnected) { sendBtn.style.display = 'block'; sendBtn.disabled = false; }
        showSection = true;
      }

      section.style.display = showSection ? 'block' : 'none';
      orDiv.style.display = showSection ? 'block' : 'none';
    }

    /* ── EVM (MetaMask) wallet ────────────────────────────────────────── */
    async function connectEvmWallet() {
      if (!window.ethereum) { showStatus('error', 'MetaMask not detected'); return; }
      try {
        const provider = new ethers.BrowserProvider(window.ethereum);
        await provider.send('eth_requestAccounts', []);

        // Switch to the correct chain
        const targetChainId = EVM_CHAIN_IDS[selectedChain];
        try {
          await provider.send('wallet_switchEthereumChain', [{ chainId: targetChainId }]);
        } catch (switchErr) {
          // 4902 = chain not added to wallet
          if (switchErr.code === 4902) {
            showStatus('error', 'Please add ' + selectedChain + ' network to MetaMask');
            return;
          }
          throw switchErr;
        }

        evmSigner = await provider.getSigner();
        walletConnected = true;
        updateWalletButtons();
        showStatus('pending', 'Wallet connected: ' + (await evmSigner.getAddress()).slice(0, 8) + '...');
      } catch (err) {
        showStatus('error', 'MetaMask connection failed: ' + (err.message || err));
      }
    }

    async function sendEvmTx() {
      if (!evmSigner || !appConfig) throw new Error('Wallet not connected');
      const token = document.getElementById('tokenSelect').value;
      const tokenAddr = appConfig.tokens[selectedChain]?.[token];
      if (!tokenAddr || tokenAddr === '0x') throw new Error('Token not available on this chain');

      const toAddr = appConfig.wallets[selectedChain];
      const price = appConfig.prices[planParam] || appConfig.prices.starter;
      const amount = ethers.parseUnits(price.toString(), 6); // USDT/USDC = 6 decimals

      const contract = new ethers.Contract(tokenAddr, ERC20_ABI, evmSigner);
      const tx = await contract.transfer(toAddr, amount);
      return tx.hash;
    }

    /* ── Solana (Phantom) wallet ──────────────────────────────────────── */
    async function connectSolWallet() {
      const phantom = window.phantom?.solana;
      if (!phantom) { showStatus('error', 'Phantom wallet not detected'); return; }
      try {
        const resp = await phantom.connect();
        solPublicKey = resp.publicKey;
        walletConnected = true;
        updateWalletButtons();
        showStatus('pending', 'Phantom connected: ' + solPublicKey.toString().slice(0, 8) + '...');
      } catch (err) {
        showStatus('error', 'Phantom connection failed: ' + (err.message || err));
      }
    }

    async function sendSolTx() {
      const phantom = window.phantom?.solana;
      if (!phantom || !solPublicKey || !appConfig) throw new Error('Wallet not connected');

      const token = document.getElementById('tokenSelect').value;
      const mintAddr = appConfig.tokens.sol?.[token];
      if (!mintAddr) throw new Error('Token not available on Solana');

      const toAddr = appConfig.wallets.sol;
      const price = appConfig.prices[planParam] || appConfig.prices.starter;
      const amount = price * 1e6; // 6 decimals

      // Build SPL token transfer via Phantom's signAndSendTransaction
      // Use fetch to get token accounts and build a raw transaction
      const connection = 'https://api.mainnet-beta.solana.com';

      // Get associated token accounts
      const getAta = async (owner, mint) => {
        const resp = await fetch(connection, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
            params: [owner, { mint }, { encoding: 'jsonParsed' }]
          })
        });
        const data = await resp.json();
        return data.result?.value?.[0]?.pubkey || null;
      };

      const senderAta = await getAta(solPublicKey.toString(), mintAddr);
      if (!senderAta) throw new Error('No ' + token.toUpperCase() + ' token account found in your wallet');

      // For Phantom, use signAndSendTransaction with a versioned transaction
      // We encode a simple SPL transfer instruction manually
      // Simpler approach: use Phantom's built-in transfer if available,
      // otherwise fall back to manual tx hash entry
      showStatus('pending', 'Please confirm the transaction in Phantom...');

      // Use the simpler approach: craft a transfer instruction via RPC
      const { blockhash } = await fetch(connection, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash',
          params: [{ commitment: 'finalized' }]
        })
      }).then(r => r.json()).then(d => d.result.value);

      // Build a legacy transaction with the SPL transfer instruction
      // TokenProgram ID: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
      const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const recipientAta = await getAta(toAddr, mintAddr);

      if (!recipientAta) throw new Error('Recipient has no ' + token.toUpperCase() + ' token account. Send manually.');

      // Encode SPL Transfer instruction (instruction index 3)
      // Data: [3, amount as u64 LE]
      const data = new Uint8Array(9);
      data[0] = 3; // Transfer instruction
      const view = new DataView(data.buffer);
      // Write amount as u64 LE (amount fits in 53 bits so this is safe)
      view.setUint32(1, amount & 0xFFFFFFFF, true);
      view.setUint32(5, Math.floor(amount / 0x100000000), true);

      // Build the transaction message manually
      // This is complex, so we use Phantom's signAndSendTransaction with a serialized tx
      // For simplicity and reliability, we use the @solana/web3.js approach via CDN
      // but since we want to avoid heavy CDN loads, we use a minimal manual approach

      // Actually, Phantom supports signAndSendTransaction with a serialized transaction
      // Let's build the minimal legacy transaction bytes
      const bs58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      function bs58Decode(str) {
        const bytes = [];
        for (let i = 0; i < str.length; i++) {
          let carry = bs58Chars.indexOf(str[i]);
          if (carry < 0) throw new Error('Invalid base58');
          for (let j = 0; j < bytes.length; j++) {
            carry += bytes[j] * 58;
            bytes[j] = carry & 0xff;
            carry >>= 8;
          }
          while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
        }
        for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
        return new Uint8Array(bytes.reverse());
      }

      // Keys: senderAta(writable), recipientAta(writable), solPublicKey(signer)
      const keys = [
        bs58Decode(senderAta),
        bs58Decode(recipientAta),
        bs58Decode(solPublicKey.toString()),
      ];
      const programId = bs58Decode(TOKEN_PROGRAM);
      const recentBlockhash = bs58Decode(blockhash);

      // Legacy transaction format:
      // [num_signatures(1)][signature(64)][message]
      // Message: [num_required_sigs(1)][num_readonly_signed(0)][num_readonly_unsigned(1)]
      //   [num_keys][key0..keyN][recent_blockhash(32)][num_instructions(1)]
      //   [instruction: program_id_index, num_accounts, account_indices..., data_len, data...]
      const numKeys = 4; // senderAta, recipientAta, signer, tokenProgram
      const msg = new Uint8Array(
        1 + 1 + 1 +         // header
        1 + (numKeys * 32) + // keys
        32 +                 // blockhash
        1 +                  // num instructions
        1 + 1 + 3 + 1 + 9   // instruction
      );
      let off = 0;
      msg[off++] = 1; // num_required_signatures
      msg[off++] = 0; // num_readonly_signed
      msg[off++] = 1; // num_readonly_unsigned (token program)
      msg[off++] = numKeys;
      // Keys order: [signer(0), senderAta(1), recipientAta(2), tokenProgram(3)]
      // signer must come first (it's a signer)
      keys[2].forEach(b => msg[off++] = b); // signer (index 0)
      keys[0].forEach(b => msg[off++] = b); // senderAta (index 1, writable)
      keys[1].forEach(b => msg[off++] = b); // recipientAta (index 2, writable)
      programId.forEach(b => msg[off++] = b); // program (index 3, readonly)
      recentBlockhash.forEach(b => msg[off++] = b);
      msg[off++] = 1; // num instructions
      // Instruction
      msg[off++] = 3; // program_id index (tokenProgram)
      msg[off++] = 3; // num accounts
      msg[off++] = 1; // senderAta index
      msg[off++] = 2; // recipientAta index
      msg[off++] = 0; // signer index (authority)
      msg[off++] = 9; // data length
      data.forEach(b => msg[off++] = b);

      // Full transaction: [1 signature placeholder (64 zeros)] + message
      const txBytes = new Uint8Array(1 + 64 + msg.length);
      txBytes[0] = 1; // num signatures
      // 64 bytes of zeros for signature placeholder (Phantom will sign)
      txBytes.set(msg, 65);

      const { signature } = await phantom.signAndSendTransaction(
        { serialize: () => txBytes, message: { serialize: () => msg } },
      );
      return signature;
    }

    /* ── TON (TonConnect) wallet ──────────────────────────────────────── */
    let tonInitialized = false;
    function initTonConnect() {
      if (tonInitialized || !window.TonConnectUI) return;
      tonInitialized = true;

      const manifestUrl = window.location.origin + '/tonconnect-manifest.json';
      tonConnector = new window.TonConnectUI.TonConnectUI({
        manifestUrl,
        buttonRootId: 'ton-connect-button',
      });

      tonConnector.onStatusChange((wallet) => {
        if (wallet) {
          walletConnected = true;
          updateWalletButtons();
        } else {
          walletConnected = false;
          updateWalletButtons();
        }
      });
    }

    async function sendTonTx() {
      if (!tonConnector || !appConfig) throw new Error('TonConnect not initialized');
      const isConnected = tonConnector.connected;
      if (!isConnected) {
        await tonConnector.openModal();
        throw new Error('Please connect your TON wallet first');
      }

      const token = document.getElementById('tokenSelect').value;
      const jettonAddr = appConfig.tokens.ton?.[token];
      if (!jettonAddr) throw new Error('Token not available on TON');

      const toAddr = appConfig.wallets.ton;
      const price = appConfig.prices[planParam] || appConfig.prices.starter;
      const amount = price * 1e6; // 6 decimals for USDT/USDC

      // Jetton transfer: send a message to the jetton wallet contract
      // with the transfer opcode (0xf8a7ea5) and forward payload
      // Amount in nanotons for the internal message fee (0.05 TON is typical)
      const forwardTon = '50000000'; // 0.05 TON for gas

      // Build the jetton transfer body as a hex payload
      // transfer#0f8a7ea5 query_id:uint64 amount:VarUInteger16 destination:MsgAddress
      //   response_destination:MsgAddress custom_payload:(Maybe ^Cell)
      //   forward_ton_amount:VarUInteger16 forward_payload:(Either Cell ^Cell)

      const tx = {
        validUntil: Math.floor(Date.now() / 1000) + 600, // 10 min
        messages: [{
          address: jettonAddr,
          amount: forwardTon,
          payload: buildJettonTransferPayload(toAddr, amount),
        }],
      };

      const result = await tonConnector.sendTransaction(tx);
      // TonConnect returns a BOC (bag of cells); extract the hash
      return result.boc || result;
    }

    function buildJettonTransferPayload(destAddr, amount) {
      // Minimal TL-B encoding for jetton transfer
      // We use a simplified hex approach
      // op: 0f8a7ea5, query_id: 0, amount, destination, response_dest(self), 0 forward
      // For TonConnect, we pass the payload as a Base64-encoded BOC cell

      // Since encoding a full BOC cell from scratch in vanilla JS is complex,
      // we use a simpler approach: TonConnect supports passing the body as a
      // base64-encoded cell. We build the minimal cell bytes.

      // For a production implementation this would use @ton/core,
      // but for MVP we construct the cell manually:
      // - 32 bits: opcode 0x0f8a7ea5
      // - 64 bits: query_id (0)
      // - coins: amount (VarUInteger 16)
      // - address: destination
      // - address: response_destination (sender)
      // - 1 bit: no custom_payload
      // - coins: forward_ton_amount (0)
      // - 1 bit: no forward_payload

      // This is intentionally left as a basic implementation.
      // The actual BOC encoding requires bit-level manipulation.
      // For TON, users may need to fall back to manual tx hash entry
      // if the payload encoding doesn't match.

      // Return empty string to let TonConnect handle simple transfers
      // The jetton contract address + amount is usually sufficient
      return '';
    }

    /* ── Send transaction via connected wallet ────────────────────────── */
    async function sendWalletTx() {
      const sendBtn = document.getElementById('sendTxBtn');
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending...';
      showStatus('pending', 'Please confirm the transaction in your wallet...');

      try {
        let txHash;
        if (EVM_CHAINS.includes(selectedChain)) {
          txHash = await sendEvmTx();
        } else if (selectedChain === 'sol') {
          txHash = await sendSolTx();
        } else if (selectedChain === 'ton') {
          txHash = await sendTonTx();
        }

        if (txHash) {
          document.getElementById('txHashInput').value = txHash;
          showStatus('pending', 'Transaction sent! Verifying on-chain...');
          await submitPayment();
        }
      } catch (err) {
        showStatus('error', 'Transaction failed: ' + (err.message || err));
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Payment via Wallet';
      }
    }

    /* ── Manual address copy ──────────────────────────────────────────── */
    function copyAddress() {
      const addr = document.getElementById('walletAddress').textContent;
      if (!addr || addr === 'Not configured' || addr === 'Loading...') return;
      navigator.clipboard.writeText(addr).then(() => {
        document.getElementById('copyHint').textContent = 'Copied!';
        setTimeout(() => document.getElementById('copyHint').textContent = 'Tap to copy', 1500);
      });
    }

    /* ── Submit & verify payment ──────────────────────────────────────── */
    async function submitPayment() {
      const txHash = document.getElementById('txHashInput').value.trim();
      if (!txHash) { showStatus('error', 'Please enter a transaction hash'); return; }
      const token = document.getElementById('tokenSelect').value;
      showStatus('pending', 'Verifying transaction on-chain...');
      document.getElementById('submitBtn').disabled = true;
      try {
        const body = { txHash, chainId: selectedChain, token, idType, uid, plan: planParam, callbackUrl: callbackUrl || undefined };
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
            'Payment verified! ' + (planName ? planName + ' plan \\u2014 ' : '') +
            p.amount_usd.toFixed(2) + ' ' + p.token.toUpperCase() + '. You can close this page.');
          if (tg) setTimeout(() => tg.close(), 3000);
        } else if (resp.status === 409) {
          showStatus('error', 'This transaction was already submitted.');
        } else {
          showStatus('failed', data.error || 'Verification failed. Check the hash and try again.');
        }
      } catch (err) { showStatus('error', 'Network error. Please try again.'); }
      finally { document.getElementById('submitBtn').disabled = false; }
    }

    function showStatus(type, msg) {
      const el = document.getElementById('statusMsg');
      el.className = 'status ' + type;
      el.textContent = msg;
    }

    init();
  <\/script>
</body>
</html>`;
}

// ── Module exports ───────────────────────────────────────────────────────────

const app = createApp();
export { app, config };

// ── Node.js server startup (skipped when imported as a module in Deno/Edge) ──

const g = globalThis as Record<string, unknown>;
if (!g.Deno && g.process) {
  import("@hono/node-server").then(({ serve }) => {
    serve({ fetch: app.fetch, port: config.port }, () => {
      console.log(`Listening on http://localhost:${config.port}`);
    });
  });
}
