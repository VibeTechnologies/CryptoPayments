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

  // ── Default payment page (Telegram Mini App) ──────────────────────────────

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
  <style>
    :root { --bg:#0a0a0a; --surface:#141414; --border:#262626; --text:#e5e5e5; --text-dim:#888; --accent:#3b82f6; --accent-hover:#2563eb; --success:#4ade80; --error:#f87171; }
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
    button { width:100%; padding:14px; background:var(--accent); color:#fff; border:none; border-radius:8px; font-size:15px; font-weight:600; cursor:pointer; margin-top:12px; }
    button:hover { background:var(--accent-hover); }
    button:disabled { background:#262626; color:#666; cursor:not-allowed; }
    .status { margin-top:12px; padding:10px 12px; border-radius:8px; font-size:13px; display:none; }
    .status.pending { background:#1a1500; border:1px solid #854d0e; color:#fbbf24; display:block; }
    .status.verified { background:#001a00; border:1px solid #166534; color:var(--success); display:block; }
    .status.failed, .status.error { background:#1a0000; border:1px solid #991b1b; color:var(--error); display:block; }
    .chain-badges { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px; }
    .chain-badge { padding:6px 12px; border-radius:20px; font-size:12px; font-weight:600; cursor:pointer; border:1px solid #333; background:#1a1a1a; color:var(--text-dim); transition:all .2s; }
    .chain-badge.active { background:var(--accent); color:#fff; border-color:var(--accent); }
    .powered { text-align:center; margin-top:20px; font-size:11px; color:#333; }
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
    let selectedChain = 'base';
    let appConfig = null;

    async function init() {
      try {
        const resp = await fetch('/api/config');
        appConfig = await resp.json();
        updateDisplay();
      } catch (e) { console.error('Config load error', e); }
    }

    function selectChain(chain) {
      selectedChain = chain;
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
          body: JSON.stringify({ txHash, chainId: selectedChain, token, idType: 'tg', uid: sessionId, plan: '${planLabel?.toLowerCase() ?? ""}' }),
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
    button {
      width: 100%; padding: 14px; background: var(--accent); color: #fff; border: none;
      border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;
      margin-top: 12px; transition: background 0.2s;
    }
    button:hover { background: var(--accent-hover); }
    button:disabled { background: #262626; color: #666; cursor: not-allowed; }
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

    let selectedChain = 'base';
    let appConfig = null;

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

    function selectChain(chain) {
      selectedChain = chain;
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
  </script>
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
