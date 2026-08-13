import { Hono, type Context } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
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
  getPaymentIntentByTx,
  listPaymentIntents,
  updatePaymentIntentStatus,
  createCheckoutSession,
  getCheckoutSessionById,
  completeCheckoutSession,
  listWebhookEvents,
  createWebhookEvent,
  recordCallbackOutcome,
  type PaymentRecord,
  type PaymentIntentRecord,
} from "./db.ts";
import { verifyTransfer, resolveplan } from "./verify.ts";
import { verifyTelegramInitData } from "./telegram.ts";

const config = loadConfig();
const db = createDB(config.supabaseUrl, config.supabaseKey);

const TOPUP_PRICES: Record<string, number> = { small: 5, medium: 10, large: 25 };

/**
 * Constant-time string comparison to prevent timing-based API key leaks.
 * Returns false (not true) on length mismatch so unequal lengths are not revealed
 * by zero-time returns.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  // Pad the shorter string so both buffers are the same length; the final
  // timingSafeEqual result is ORed with the length-mismatch flag so an
  // equal-length match on padded bytes cannot produce a false positive.
  const lengthsMatch = a.length === b.length;
  const maxLen = Math.max(a.length, b.length, 1);
  const bufA = Buffer.alloc(maxLen);
  const bufB = Buffer.alloc(maxLen);
  bufA.write(a);
  bufB.write(b);
  return timingSafeEqual(bufA, bufB) && lengthsMatch;
}

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
    // Fail-closed: empty API_KEY means no valid key is configured — deny all.
    if (!config.apiKey) return false;
    const provided = c.req.header("x-api-key");
    if (!provided) return false;
    return timingSafeEqualStr(provided, config.apiKey);
  }

  function verifyCheckoutIntent(input: {
    uid: string;
    plan?: string;
    topup?: string;
    callbackUrl?: string;
    tenantType?: string;
    vmProvider?: string;
    hostType?: string;
    /**
     * Primary runtime requested at checkout ("openclaw" | "hermes").
     *
     * MUST be part of the canonical string. OpenClawBot's `buildCryptoCheckoutUrl`
     * signs EVERY intent param including this one, so omitting it here produced a
     * signature that could never match and 401'd the request — every Hermes
     * purchase was unsettleable while the customer's on-chain transfer had
     * already been mined (OpenClawBot#3583).
     *
     * It must also stay signed rather than being accepted unsigned: this field
     * selects which runtime the buyer gets, so an unsigned copy would let anyone
     * swap the delivered product after the fact.
     */
    deploymentType?: string;
    amountUsd?: string;
    exp?: string;
    sig?: string;
  }): boolean {
    if (!config.checkoutSecret || !input.exp || !input.sig) return false;
    const exp = Number(input.exp);
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
    const params = new URLSearchParams();
    if (input.plan) params.set("plan", input.plan);
    if (input.topup) params.set("topup", input.topup);
    params.set("uid", input.uid);
    params.set("idtype", "tg");
    if (input.amountUsd) params.set("amountUsd", input.amountUsd);
    params.set("exp", input.exp);
    if (input.callbackUrl) params.set("callback", input.callbackUrl);
    if (input.tenantType) {
      params.set("tenantType", input.tenantType);
      params.set("tenant", input.tenantType);
    }
    if (input.vmProvider) params.set("vmp", input.vmProvider);
    if (input.hostType) params.set("hostType", input.hostType);
    if (input.deploymentType) params.set("deploymentType", input.deploymentType);
    const canonical = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    const expected = createHmac("sha256", config.checkoutSecret)
      .update(canonical)
      .digest("hex");
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(input.sig);
    return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
  }

  // ── Shared verification finalization (POST verify + GET lazy re-verify) ────
  //
  // Applies the same plan/top-up amount validation on both paths, marks the
  // payment verified/failed, and fires the webhook callback when configured.
  type VerificationContext = {
    callbackUrl?: string;
    plan?: string;
    topup?: string;
    tenantType?: string;
    vmProvider?: string;
    hostType?: string;
    /** Signed primary runtime ("openclaw" | "hermes"). */
    deploymentType?: string;
    /** Signed checkout-intent amount (string, as signed). */
    amountUsd?: string;
    checkoutIntentVerified?: boolean;
  };

  async function finalizeVerifiedPayment(
    paymentId: string,
    result: { from: string; to: string; amountRaw: string; amountUsd: number; blockNumber?: number },
    ctx: VerificationContext,
    waitForCallback = false,
  ): Promise<{ ok: true; payment: PaymentRecord | null } | { ok: false; error: string }> {
    // Top-up flow (#29): require the on-chain amount to cover the pack price.
    if (ctx.topup && ctx.topup in TOPUP_PRICES && result.amountUsd < TOPUP_PRICES[ctx.topup]) {
      await markPaymentFailed(appDb, paymentId);
      return { ok: false, error: `Underpaid: expected $${TOPUP_PRICES[ctx.topup]}, got $${result.amountUsd}` };
    }

    // Plan flow (main): resolve & validate the plan against the verified amount.
    const planId = resolveplan(result.amountUsd, config.prices);
    const signedAmountUsd = Number(ctx.amountUsd);
    const matchesSignedIntentAmount = !!ctx.checkoutIntentVerified &&
      !!ctx.plan &&
      Number.isFinite(signedAmountUsd) &&
      Math.abs(result.amountUsd - signedAmountUsd) < 0.01;
    const verifiedPlanId = ctx.topup
      ? undefined
      : matchesSignedIntentAmount
        ? ctx.plan
        : planId;
    if (!ctx.topup && ctx.plan && verifiedPlanId !== ctx.plan) {
      await markPaymentFailed(appDb, paymentId);
      return { ok: false, error: "Verified amount does not match requested plan" };
    }
    if (!ctx.topup && !verifiedPlanId) {
      await markPaymentFailed(appDb, paymentId);
      return { ok: false, error: "Verified amount does not match a supported plan" };
    }

    await markPaymentVerified(appDb, paymentId, {
      fromAddress: result.from,
      toAddress: result.to,
      amountRaw: result.amountRaw,
      amountUsd: result.amountUsd,
      blockNumber: result.blockNumber,
      planId: verifiedPlanId ?? undefined,
    });

    const verified = await getPaymentById(appDb, paymentId);

    // ── Send webhook callback (fire-and-forget) ──
    // Record the delivery OUTCOME, do not just fire and forget.
    //
    // The old form was `.catch(err => console.error(...))`, so a refused or
    // failing callback left a `verified` payment with no webhook and no trace —
    // OpenClabBot#3600. `callback_state` is what makes
    // "settled but never delivered" queryable, and therefore alertable.
    if (ctx.callbackUrl && !config.callbackSecret && verified) {
      await recordCallbackOutcome(appDb, paymentId, ctx.callbackUrl, "CALLBACK_SECRET is not configured");
      if (waitForCallback) throw new CallbackNotDeliverableError("CALLBACK_SECRET is not configured");
    } else if (ctx.callbackUrl && config.callbackSecret && verified) {
      const deliver = async () => {
        try {
          await sendCallback(ctx.callbackUrl!, verified, {
            topup: ctx.topup,
            tenantType: ctx.tenantType,
            vmProvider: ctx.vmProvider,
            hostType: ctx.hostType,
            deploymentType: ctx.deploymentType,
          });
          await recordCallbackOutcome(appDb, paymentId, ctx.callbackUrl!, null);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.error(`[PAYMENT-LOST] payment ${paymentId} verified but callback failed: ${reason}`);
          await recordCallbackOutcome(appDb, paymentId, ctx.callbackUrl!, reason);
          throw err;
        }
      };
      if (waitForCallback) await deliver();
      else void deliver().catch(() => undefined);
    } else if (verified && !ctx.callbackUrl) {
      // No callback at all on a verified payment is also money-in-nothing-out.
      console.error(
        `[PAYMENT-LOST] payment ${paymentId} is VERIFIED but carried NO callbackUrl — ` +
          `nothing will ever be provisioned for it.`,
      );
      await recordCallbackOutcome(appDb, paymentId, null, "no callbackUrl on the intent");
    }

    return { ok: true, payment: verified };
  }

  function paymentIntentStatus(intent: PaymentIntentRecord) {
    const callback = (intent.metadata?.callback_state ?? {}) as Record<string, unknown>;
    const callbackStatus = typeof callback.status === "string" ? callback.status : "not_attempted";
    return {
      id: intent.stripe_id,
      status: intent.status,
      chain_id: intent.chain_id,
      token: intent.token,
      tx_hash: intent.tx_hash,
      amount: intent.amount,
      currency: intent.currency,
      plan_id: intent.plan_id,
      topup_id: intent.topup_id,
      created_at: intent.created_at,
      updated_at: intent.updated_at,
      succeeded_at: intent.succeeded_at,
      callback: {
        status: callbackStatus,
        attempts: typeof callback.attempts === "number" ? callback.attempts : 0,
        delivered_at: typeof callback.delivered_at === "string" ? callback.delivered_at : null,
        last_attempt_at: typeof callback.last_attempt_at === "string" ? callback.last_attempt_at : null,
        last_error: typeof callback.last_error === "string" ? callback.last_error : null,
      },
      needs_action:
        intent.status === "succeeded" && callbackStatus !== "delivered"
          ? "deliver_callback"
          : intent.status === "processing" || intent.status === "requires_payment_method"
            ? "verify_chain"
            : null,
    };
  }

  async function reconcilePaymentIntent(intent: PaymentIntentRecord) {
    if (!intent.tx_hash || !intent.chain_id) {
      return { ok: false as const, retryable: false, error: "Payment intent has no chain transaction" };
    }

    const meta = (intent.metadata ?? {}) as Record<string, unknown>;
    const str = (value: unknown): string | undefined =>
      typeof value === "string" && value ? value : undefined;
    const callbackUrl = str(meta.callbackUrl);
    const callbackState = (meta.callback_state ?? {}) as Record<string, unknown>;

    if (intent.status === "succeeded" && callbackState.status === "delivered") {
      return { ok: true as const, action: "already_delivered", intent };
    }

    if (intent.status !== "succeeded") {
      const result = await verifyTransfer(intent.tx_hash, intent.chain_id as ChainId, config);
      if (result === "pending") {
        return { ok: false as const, retryable: true, error: "Transaction is not yet final" };
      }
      if (!result) {
        return { ok: false as const, retryable: true, error: "Transaction not found; terminal failure is unproven" };
      }
      const outcome = await finalizeVerifiedPayment(intent.id, result, {
        callbackUrl,
        plan: str(meta.plan) ?? intent.plan_id ?? undefined,
        topup: str(meta.topup) ?? intent.topup_id ?? undefined,
        tenantType: str(meta.tenantType),
        vmProvider: str(meta.vmProvider),
        hostType: str(meta.hostType),
        deploymentType: str(meta.deploymentType),
        amountUsd: str(meta.amountUsd),
        checkoutIntentVerified: meta.checkoutIntentVerified === true,
      }, true);
      if (!outcome.ok) return { ok: false as const, retryable: false, error: outcome.error };
      return { ok: true as const, action: "verified_and_delivered", intent: await getPaymentIntentById(appDb, intent.id) };
    }

    const payment = await getPaymentById(appDb, intent.id);
    if (!payment) return { ok: false as const, retryable: false, error: "Payment customer not found" };
    if (!callbackUrl) {
      await recordCallbackOutcome(appDb, intent.id, null, "no callbackUrl on the intent");
      return { ok: false as const, retryable: false, error: "Verified payment has no callback URL" };
    }
    await sendCallback(callbackUrl, payment, {
      topup: str(meta.topup),
      tenantType: str(meta.tenantType),
      vmProvider: str(meta.vmProvider),
      hostType: str(meta.hostType),
      deploymentType: str(meta.deploymentType),
    });
    await recordCallbackOutcome(appDb, intent.id, callbackUrl, null);
    return { ok: true as const, action: "callback_delivered", intent: await getPaymentIntentById(appDb, intent.id) };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LEGACY API (backward compatible)
  // ══════════════════════════════════════════════════════════════════════════

  // ── Health ──────────────────────────────────────────────────────────────────

  app.get("/api/health", (c) =>
    c.json({ ok: true, chains: ["base", "eth", "arbitrum", "ton", "sol", "base_sepolia", "eth_sepolia"], tokens: ["usdt", "usdc", "ausd"] }),
  );

  // ── Public config ──────────────────────────────────────────────────────────

  app.get("/api/config", (c) => {
    return c.json({
      wallets: config.wallets,
      prices: config.prices,
      tokens: TOKEN_ADDRESSES,
      chains: ["base", "eth", "arbitrum", "ton", "sol", "base_sepolia", "eth_sepolia"],
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
      topup?: string;
      tenantType?: "personal" | "team";
      vmProvider?: "azure" | "hetzner";
      hostType?: "vps";
      deploymentType?: "openclaw" | "hermes";
      amountUsd?: string;
      callbackUrl?: string;
      initData?: string;
      apiKey?: string;
      exp?: string;
      sig?: string;
    }>();

    // ── Auth (optional but recommended) ──
    let authed = false;
    let checkoutIntentVerified = false;
    if (body.initData && config.telegramBotToken) {
      const result = await verifyTelegramInitData(body.initData, config.telegramBotToken);
      if (!result.valid) {
        return c.json({ error: "Invalid Telegram initData" }, 401);
      }
      if (result.user) {
        body.idType = "tg";
        body.uid = String(result.user.id);
      }
      authed = true;
    } else if (body.apiKey) {
      if (!config.apiKey || !timingSafeEqualStr(body.apiKey, config.apiKey)) {
        return c.json({ error: "Invalid API key" }, 401);
      }
      authed = true;
    } else {
      try {
        if (verifyCheckoutIntent(body)) {
          authed = true;
          checkoutIntentVerified = true;
        }
      } catch (e) {
        console.error("verifyCheckoutIntent crashed:", e);
      }
    }

    if (!authed) {
      return c.json({ error: "Authentication required" }, 401);
    }

    // ── Validate inputs ──
    if (!body.txHash || typeof body.txHash !== "string") {
      return c.json({ error: "txHash is required" }, 400);
    }
    if (!body.chainId || !["base", "eth", "arbitrum", "ton", "sol", "base_sepolia", "eth_sepolia"].includes(body.chainId)) {
      return c.json({ error: "chainId must be base, eth, arbitrum, ton, sol, base_sepolia, or eth_sepolia" }, 400);
    }
    if (!body.idType || !["tg", "email"].includes(body.idType)) {
      return c.json({ error: "idType must be 'tg' or 'email'" }, 400);
    }
    if (!body.uid) {
      return c.json({ error: "uid is required" }, 400);
    }

    const token = body.token || "usdt";
    if (!["usdt", "usdc", "ausd"].includes(token)) {
      return c.json({ error: "token must be usdt, usdc, or ausd" }, 400);
    }

    if (body.topup !== undefined && !(body.topup in TOPUP_PRICES)) {
      return c.json({ error: "topup must be small, medium, or large" }, 400);
    }

    // ── Duplicate check ──
    const existing = await getPaymentByTx(appDb, body.txHash, body.chainId);
    if (existing) {
      return c.json({ error: "Transaction already submitted", payment: existing }, 409);
    }

    // ── Insert pending payment ──
    // Persist the callback/verification context in payment_intents.metadata so
    // the GET /api/payment/:id lazy re-verification path (SPA polling after a
    // 202 pending) can run the same validation and send the same webhook
    // callback as this POST path (OpenClawBot#3220).
    const verificationContext: Record<string, unknown> = {
      ...(body.callbackUrl ? { callbackUrl: body.callbackUrl } : {}),
      ...(body.plan ? { plan: body.plan } : {}),
      ...(body.topup ? { topup: body.topup } : {}),
      ...(body.tenantType ? { tenantType: body.tenantType } : {}),
      ...(body.vmProvider ? { vmProvider: body.vmProvider } : {}),
      ...(body.hostType ? { hostType: body.hostType } : {}),
      ...(body.deploymentType ? { deploymentType: body.deploymentType } : {}),
      ...(body.amountUsd ? { amountUsd: body.amountUsd } : {}),
      checkoutIntentVerified,
    };
    let payment: PaymentRecord;
    try {
      payment = await insertPayment(appDb, {
        idType: body.idType,
        uid: body.uid,
        txHash: body.txHash,
        chainId: body.chainId,
        token,
        amountRaw: "0",
        amountUsd: 0,
        planId: body.topup ? undefined : (body.plan ?? undefined),
        topupId: body.topup ?? undefined,
        metadata: verificationContext,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Failed to record payment: ${msg}` }, 500);
    }

    // ── Verify on-chain ──
    try {
      const result = await verifyTransfer(body.txHash, body.chainId, config);

      if (result === "pending") {
        // TX not yet mined or not enough confirmations — leave payment as pending, caller retries
        const current = await getPaymentById(appDb, payment.id);
        return c.json({ payment: current, pending: true }, 202);
      }

      if (!result) {
        await markPaymentFailed(appDb, payment.id);
        const updated = await getPaymentById(appDb, payment.id);
        return c.json({ payment: updated, error: "Transfer not found or not to our wallet" }, 400);
      }

      // Top-up / plan validation + verification + webhook callback — shared
      // with the GET lazy re-verification path.
      const outcome = await finalizeVerifiedPayment(payment.id, result, {
        callbackUrl: body.callbackUrl,
        plan: body.plan,
        topup: body.topup,
        tenantType: body.tenantType,
        vmProvider: body.vmProvider,
        hostType: body.hostType,
        deploymentType: body.deploymentType,
        amountUsd: body.amountUsd,
        checkoutIntentVerified,
      });
      if (!outcome.ok) {
        return c.json({ error: outcome.error, payment: await getPaymentById(appDb, payment.id) }, 400);
      }

      return c.json({ payment: outcome.payment });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markPaymentFailed(appDb, payment.id);
      return c.json(
        { error: `Verification failed: ${msg}`, payment: await getPaymentById(appDb, payment.id) },
        500,
      );
    }
  });

  // ── Check payment status ───────────────────────────────────────────────────

  app.get("/api/payment/:id", async (c) => {
    // Public by payment ID — no API key required for polling (frontend can't hold secrets).
    // Admin callers may still pass x-api-key; it's accepted but not enforced here.

    const id = c.req.param("id");
    // Accept stripe_id ("pi_..."), UUID (payment_intents.id — what POST
    // /api/payment returns and the /pay SPA polls with), or legacy numeric id.
    // Regression #3220: this used to reject UUIDs ("Invalid payment ID" 400),
    // which broke the SPA's pollPaymentVerified loop for any payment whose
    // initial POST verify returned "pending" — the payment then never showed
    // "Payment verified!" even after the tx confirmed on-chain.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const numId = Number(id);
    if (!id.startsWith("pi_") && !UUID_RE.test(id) && Number.isNaN(numId)) {
      return c.json({ error: "Invalid payment ID" }, 400);
    }

    let payment = await getPaymentById(appDb, id);
    if (!payment) return c.json({ error: "Payment not found" }, 404);

    // Lazy re-verification: if still pending, check the chain now.
    // This is what powers the frontend polling loop — the status transitions
    // from "pending" to "verified" (or "failed") on the first GET after mining.
    // OpenClawBot#3220: this path must replicate POST's semantics — same
    // plan/top-up amount validation, planId persistence, and webhook callback —
    // using the server-persisted metadata (never client-supplied at poll time).
    if (payment.status === "pending" && payment.tx_hash && payment.chain_id) {
      try {
        const result = await verifyTransfer(payment.tx_hash, payment.chain_id as ChainId, config);
        if (result && result !== "pending") {
          const meta = (payment.metadata ?? {}) as Record<string, unknown>;
          const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
          await finalizeVerifiedPayment(payment.id, result, {
            callbackUrl: str(meta.callbackUrl),
            plan: str(meta.plan) ?? payment.plan_id ?? undefined,
            topup: str(meta.topup) ?? payment.topup_id ?? undefined,
            tenantType: str(meta.tenantType),
            vmProvider: str(meta.vmProvider),
            hostType: str(meta.hostType),
            deploymentType: str(meta.deploymentType),
            amountUsd: str(meta.amountUsd),
            checkoutIntentVerified: meta.checkoutIntentVerified === true,
          });
          payment = await getPaymentById(appDb, payment.id);
        }
        // result === "pending": tx not yet mined — return current status as-is
      } catch {
        // Re-verify failed (RPC error, etc.) — return current DB status; client will retry
      }
    }

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

  // ── Invoice HTML rendering (deprecated — use SPA) ──────────────────────────
  // HTML rendering moved to the Next.js SPA. This route returns JSON only.
  app.get("/v1/invoices/:id/html", async (c) => {
    const invoice = await getInvoiceWithLineItems(appDb, c.req.param("id"));
    if (!invoice) return c.json({ error: "Invoice not found" }, 404);
    return c.json({ error: "HTML rendering removed. Use the SPA at /pay or the JSON API at /v1/invoices/:id" }, 410);
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
      topup_id?: string;
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
      topupId: body.topup_id,
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

  app.get("/v1/payment_intents/by_tx/:chain/:txHash", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    const chain = c.req.param("chain");
    const txHash = c.req.param("txHash");
    if (!["base", "eth", "arbitrum", "ton", "sol", "base_sepolia", "eth_sepolia"].includes(chain)) {
      return c.json({ error: "Invalid chain" }, 400);
    }
    if (!txHash || txHash.length > 128) return c.json({ error: "Invalid transaction hash" }, 400);
    const intent = await getPaymentIntentByTx(appDb, txHash, chain);
    if (!intent) return c.json({ error: "Payment intent not found" }, 404);
    return c.json(paymentIntentStatus(intent));
  });

  app.post("/v1/payment_intents/:id/reconcile", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    const intent = await getPaymentIntentById(appDb, c.req.param("id"));
    if (!intent) return c.json({ error: "Payment intent not found" }, 404);
    try {
      const result = await reconcilePaymentIntent(intent);
      if (!result.ok) return c.json(result, result.retryable ? 409 : 422);
      return c.json({ ...result, intent: result.intent ? paymentIntentStatus(result.intent) : null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, retryable: true, error: message }, 502);
    }
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

  // ── Checkout redirect (HTML moved to SPA) ──────────────────────────────────
  app.get("/checkout/:id", async (c) => {
    const session = await getCheckoutSessionById(appDb, c.req.param("id"));
    if (!session) return c.json({ error: "Checkout session not found" }, 404);
    if (session.status === "expired") return c.json({ error: "This checkout session has expired" }, 410);
    if (session.status === "complete") return c.json({ error: "This payment has already been completed" }, 200);

    // Return checkout session JSON — the SPA reads this via /v1/checkout/sessions/:id
    return c.json({
      id: session.stripe_id,
      amount: session.amount,
      plan_id: session.plan_id,
      status: session.status,
    });
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

  // ── Payment page (HTML moved to SPA) ───────────────────────────────────────
  // The SPA is hosted separately (e.g. Vercel). These routes now return JSON
  // info directing clients to the SPA or use /api/config for configuration.
  app.get("/pay", (c) =>
    c.json({ message: "Payment page moved to the SPA frontend. Use /api/config for configuration." }),
  );
  app.get("/", (c) =>
    c.json({
      service: "OpenClaw Crypto Payments API",
      docs: "/api/config",
      version: "1.0.0",
    }),
  );

  return app;
}

// ── Webhook callback ─────────────────────────────────────────────────────────

/**
 * A verified payment whose webhook could not be delivered.
 *
 * Exists so an undelivered callback is a THROW rather than a silent `return`.
 * OpenClawBot#3600 survived precisely because every failure path here was a
 * warn-and-continue: the payment stayed `verified`, the customer got nothing,
 * and no signal existed anywhere to notice.
 */
export class CallbackNotDeliverableError extends Error {
  constructor(reason: string) {
    super(`callback not deliverable: ${reason}`);
    this.name = "CallbackNotDeliverableError";
  }
}

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

async function sendCallback(
  callbackUrl: string,
  payment: PaymentRecord,
  metadata: {
    topup?: string;
    tenantType?: string;
    vmProvider?: string;
    hostType?: string;
    deploymentType?: string;
  } = {},
): Promise<void> {
  // SSRF guard: only POST to allowlisted HTTPS hosts.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(callbackUrl);
  } catch {
    throw new CallbackNotDeliverableError("callback URL is invalid");
  }
  if (parsedUrl.protocol !== "https:") {
    throw new CallbackNotDeliverableError("callback URL must use HTTPS");
  }
  if (!config.callbackAllowlist.includes(parsedUrl.hostname)) {
    // A settled payment whose webhook is dropped is money in with nothing out.
    // This used to be console.warn + return, which is why OpenClawBot#3600
    // survived: the payment stayed `verified`, no webhook fired, no retry
    // existed, and NOTHING recorded that a delivery had been refused. Keep the
    // SSRF guard — it is correct — but make the drop impossible to miss.
    console.error(
      `[PAYMENT-LOST] sendCallback REFUSED for payment ${payment.id}: host ` +
        `"${parsedUrl.hostname}" is not in CALLBACK_URL_ALLOWLIST ` +
        `(${config.callbackAllowlist.join(", ")}). The payment is VERIFIED but the ` +
        `customer will receive NOTHING and there is no retry. Add the host to ` +
        `CALLBACK_URL_ALLOWLIST, or stop the caller from signing intents for it.`,
    );
    throw new CallbackNotDeliverableError(
      `callback host "${parsedUrl.hostname}" is not allowlisted`,
    );
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = JSON.stringify({
    event: "payment.verified",
    payment: {
      id: payment.id,
      idType: payment.id_type,
      uid: payment.uid,
      plan: payment.plan_id ?? undefined,
      topup: payment.topup_id ?? undefined,
      chain: payment.chain_id,
      token: payment.token,
      amountUsd: payment.amount_usd,
      txHash: payment.tx_hash,
      ...(metadata.topup ? { topup: metadata.topup } : {}),
      ...(metadata.tenantType ? { tenantType: metadata.tenantType } : {}),
      ...(metadata.vmProvider ? { vmProvider: metadata.vmProvider } : {}),
      ...(metadata.hostType ? { hostType: metadata.hostType } : {}),
      ...(metadata.deploymentType ? { deploymentType: metadata.deploymentType } : {}),
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
    console.error(
      `[PAYMENT-LOST] Callback to ${callbackUrl} FAILED for payment ${payment.id}: ` +
        `${resp.status} ${resp.statusText}. The payment is VERIFIED but the customer ` +
        `will receive NOTHING until this is redelivered.`,
    );
    throw new CallbackNotDeliverableError(
      `callback POST returned ${resp.status} ${resp.statusText}`,
    );
  }
  console.log(`Callback sent for payment ${payment.id}`);
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
