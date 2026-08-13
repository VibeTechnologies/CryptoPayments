import { Hono, type Context } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { cors } from "hono/cors";
import {
  loadConfig,
  productConfig,
  productConfigOrDefault,
  UnknownProductError,
  configForProduct,
  DEFAULT_PRODUCT,
  type Config,
  type ChainId,
  type TokenId,
  TOKEN_ADDRESSES,
} from "./config.ts";
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
  recordCallbackOutcome,
  recordCallbackAttempt,
  listDueCallbacks,
  type PaymentRecord,
  type PaymentIntentRecord,
} from "./db.ts";
import {
  buildSignedPayload,
  type AttemptOutcome,
  type CallbackDeliveryState,
} from "./callback-delivery.ts";
import { verifyTransfer, resolveplan } from "./verify.ts";
import { verifyTelegramInitData } from "./telegram.ts";

const config = loadConfig();
const db = createDB(config.supabaseUrl, config.supabaseKey);

/**
 * Top-up pack prices for the DEFAULT product. Kept as a module constant only
 * for validating pack NAMES; the price actually charged is read per-product
 * from `productConfig(config, product).topupPrices`.
 */
const TOPUP_PRICES: Record<string, number> = productConfig(config, DEFAULT_PRODUCT).topupPrices;

/**
 * Build the signed fields of a checkout intent as `[key, value]` pairs sorted
 * by key. Shared by the signing and verifying paths so the two can never drift.
 */
export function buildIntentFields(input: {
  uid: string;
  idType?: string;
  plan?: string;
  topup?: string;
  callbackUrl?: string;
  tenantType?: string;
  vmProvider?: string;
  hostType?: string;
  deploymentType?: string;
  product?: string;
  amountUsd?: string;
  exp?: string;
}): Array<[string, string]> {
  const params = new URLSearchParams();
  if (input.plan) params.set("plan", input.plan);
  if (input.topup) params.set("topup", input.topup);
  params.set("uid", input.uid);
  params.set("idtype", input.idType || "tg");
  if (input.amountUsd) params.set("amountUsd", input.amountUsd);
  if (input.exp) params.set("exp", input.exp);
  if (input.callbackUrl) params.set("callback", input.callbackUrl);
  if (input.tenantType) {
    params.set("tenantType", input.tenantType);
    params.set("tenant", input.tenantType);
  }
  if (input.vmProvider) params.set("vmp", input.vmProvider);
  if (input.hostType) params.set("hostType", input.hostType);
  if (input.deploymentType) params.set("deploymentType", input.deploymentType);
  if (input.product) params.set("product", input.product);
  return [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Canonical string signed by the checkout-intent HMAC.
 *
 * Length-prefixed on BOTH key and value:
 *
 *     <keyLen>:<key>=<valueLen>:<value>   joined by "\n"
 *
 * e.g. `{plan:"starter", product:"vibe"}` =>
 *     "4:plan=7:starter\n7:product=4:vibe"
 *
 * The length prefix makes a field boundary unforgeable: a reader knows exactly
 * how many characters a value occupies before it looks for the next separator,
 * so no character a value can contain — "\n", "=", ":" — can fabricate,
 * truncate or absorb a neighbouring field.
 *
 * The previous form was a bare `${key}=${value}` join on "\n". Because
 * `URLSearchParams.entries()` returns DECODED values, a raw newline inside a
 * value passed straight through, and
 *
 *     {plan: "starter\nproduct=vibe"}
 *
 * canonicalized byte-identically to `{plan:"starter", product:"vibe"}` —
 * `plan` sorts immediately before `product` — forging the `product` field that
 * selects the price table, receiving wallet and callback allowlist.
 */
export function canonicalIntentString(fields: Array<[string, string]>): string {
  return fields.map(([key, value]) => `${key.length}:${key}=${value.length}:${value}`).join("\n");
}

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

  // ── Opportunistic redelivery ────────────────────────────────────────────────
  //
  // THE SCHEDULER. A Supabase Edge Function is request-scoped: there is no
  // process that outlives the response, so `setTimeout(retry, 60_000)` is
  // silently dropped when the isolate is torn down. The only reliable clock we
  // have is "another request arrived". So every inbound request opportunistically
  // drains callbacks whose `next_attempt_at` has passed.
  //
  // Cheap by construction: `listDueCallbacks` returns [] unless a consumer is
  // actually broken, and the drain is throttled to once per
  // DRAIN_INTERVAL_MS per isolate so a burst of traffic cannot stampede a
  // struggling consumer. It runs AFTER the response is produced and never
  // rejects, so it can never affect the request that triggered it.
  app.use("*", async (c, next) => {
    await next();
    if (c.req.path.startsWith("/api/admin/")) return; // admin drain is explicit
    void maybeDrain();
  });

  const DRAIN_INTERVAL_MS = 15_000;
  let lastDrainAt = 0;
  let draining = false;

  async function maybeDrain(): Promise<void> {
    const now = Date.now();
    if (draining || now - lastDrainAt < DRAIN_INTERVAL_MS) return;
    draining = true;
    lastDrainAt = now;
    try {
      await drainDueCallbacks();
    } catch (err) {
      console.error(`[callback-drain] failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      draining = false;
    }
  }

  /**
   * Retry every callback that is `pending` and due.
   *
   * Idempotent and safe to run concurrently with itself: `computeNextState`
   * refuses to regress a `delivered` state, and a duplicate successful delivery
   * is collapsed by the consumer's txHash dedupe.
   */
  async function drainDueCallbacks(
    nowMs: number = Date.now(),
  ): Promise<{ attempted: number; delivered: number; failed: number }> {
    const due = await listDueCallbacks(appDb, nowMs);
    let delivered = 0;
    let failed = 0;

    for (const pi of due) {
      const meta = (pi.metadata ?? {}) as Record<string, unknown>;
      const state = (meta.callback_state ?? {}) as Partial<CallbackDeliveryState>;
      const url = state.url;
      if (!url) continue;

      const payment = await getPaymentById(appDb, pi.stripe_id);
      if (!payment) continue;

      const str = (v: unknown) => (typeof v === "string" ? v : undefined);
      let prod: ReturnType<typeof productConfig>;
      try {
        prod = productConfig(config, str(meta.product));
      } catch {
        // The product was removed from config while a delivery was pending.
        // Retrying can never succeed — go terminal loudly rather than loop.
        const outcome: AttemptOutcome = {
          ok: false,
          error: `unknown product "${String(meta.product)}" — cannot resolve callback allowlist`,
          permanent: true,
        };
        const next = await recordCallbackAttempt(appDb, pi.stripe_id, url, outcome, nowMs);
        logDeliveryOutcome(pi.stripe_id, payment.tx_hash, url, outcome, next);
        failed++;
        continue;
      }

      const outcome = await attemptCallback(
        url,
        payment,
        {
          topup: str(meta.topup),
          tenantType: str(meta.tenantType),
          vmProvider: str(meta.vmProvider),
          hostType: str(meta.hostType),
          deploymentType: str(meta.deploymentType),
          product: prod.id,
        },
        prod.callbackAllowlist,
      );
      const next = await recordCallbackAttempt(appDb, pi.stripe_id, url, outcome, nowMs);
      logDeliveryOutcome(pi.stripe_id, payment.tx_hash, url, outcome, next);
      if (outcome.ok) delivered++;
      else failed++;
    }

    return { attempted: due.length, delivered, failed };
  }

  /**
   * Operator escape hatch: force a redelivery sweep NOW.
   *
   * Exists because the opportunistic drain only advances when traffic arrives —
   * on a quiet night a stuck payment could sit until morning. Guarded by the
   * same API key the bot already uses.
   */
  app.post("/api/admin/callbacks/redeliver", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    const result = await drainDueCallbacks();
    return c.json({ ok: true, ...result });
  });

  /** Operator view: verified payments that are stuck or needing attention. */
  app.get("/api/admin/callbacks/stuck", async (c) => {
    if (!requireApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
    const pis = await listPaymentIntents(appDb, { limit: 200 });
    const stuck = pis
      .map((pi) => ({
        pi,
        state: ((pi.metadata ?? {}) as Record<string, unknown>).callback_state as
          | Partial<CallbackDeliveryState>
          | undefined,
      }))
      .filter(({ state }) => state && state.status !== "delivered")
      .map(({ pi, state }) => ({
        paymentId: pi.stripe_id,
        txHash: pi.tx_hash,
        status: state?.status ?? null,
        attempts: state?.attempts ?? 0,
        nextAttemptAt: state?.next_attempt_at ?? null,
        terminalReason: state?.terminal_reason ?? null,
        lastError: state?.last_error ?? null,
      }));
    return c.json({ count: stuck.length, stuck });
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
    /**
     * Product being purchased ("openclaw" | "vibe" | ...).
     *
     * MUST be inside the canonical string. `product` selects the price table,
     * the receiving wallet and the callback allowlist, so an unsigned copy would
     * let an attacker pay product A's cheap price and be credited product B's
     * expensive plan — the same class of bug as the unsigned `deploymentType`
     * in OpenClawBot#3583, where a purchase-shaping field sat outside the
     * signature.
     *
     * It is only appended when present, so a legacy intent (no `product`)
     * produces the byte-identical canonical string it produced before this
     * field existed, and keeps validating.
     */
    product?: string;
    amountUsd?: string;
    /** Identifier namespace for `uid` ("tg" | "email"). Part of the canonical string. */
    idType?: string;
    exp?: string;
    sig?: string;
  }): boolean {
    if (!config.checkoutSecret || !input.exp || !input.sig) return false;
    const exp = Number(input.exp);
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;

    // `idtype` used to be hardcoded to "tg", which made the signed-intent auth
    // path unusable for `email` identities (i.e. for the vibe product), forcing
    // vibe onto the apiKey path where `product` is unsigned. It is now taken
    // from the request and covered by the signature.
    const idType = input.idType || "tg";

    const fields = buildIntentFields({ ...input, idType });
    const expectedNew = createHmac("sha256", config.checkoutSecret)
      .update(canonicalIntentString(fields))
      .digest("hex");
    if (timingSafeEqualStr(expectedNew, input.sig)) return true;

    // ── Legacy canonical form (DEPRECATED) ────────────────────────────────
    //
    // Live OpenClawBot production signs with the old `k=v` + "\n" join, which
    // is forgeable: `URLSearchParams.entries()` returns DECODED values, so a
    // value containing a raw "\n" (or "=") can fabricate an extra field —
    // e.g. `{plan:"starter\nproduct=vibe"}` canonicalizes byte-identically to
    // `{plan:"starter", product:"vibe"}`, forging `product`.
    //
    // We keep accepting it ONLY for in-flight/legacy intents, and only when the
    // injection vector is structurally absent: no value may contain a line
    // break (see the guard below for why "=" is deliberately allowed).
    //
    // Legacy signers always emitted idtype=tg, so a legacy signature can never
    // authorise an `email` identity — accepting one would let a tg-signed
    // intent be credited to the same uid in the email namespace.
    //
    // TODO(remove-legacy-canonical): delete this branch once no signature
    // produced by the pre-length-prefix algorithm can still be within its
    // `exp` window — i.e. once every OpenClawBot deployment emitting the old
    // format has been upgraded AND the longest checkout-intent TTL (30 min)
    // has elapsed since that rollout completed.
    if (idType !== "tg") return false;

    // A legacy signature can never authorise a `product`. Legacy signers
    // predate multi-product and never emitted the field, so a genuine legacy
    // intent has no `product`. This is load-bearing, not merely tidy: the
    // newline collision below is INDISTINGUISHABLE on the legacy path when
    // replayed in its split form — a signature over
    //   {plan: "starter\nproduct=vibe"}
    // produces byte-identical legacy canonical bytes to
    //   {plan: "starter", product: "vibe"}
    // and the split form contains no "\n" for the value guard to catch.
    // Refusing `product` outright on the legacy path removes the only field
    // the collision can profitably forge (wallet / price table / allowlist).
    if (input.product) return false;

    // Guard the injection vector ONLY.
    //
    // The legacy encoding is `${key}=${value}` joined by "\n". To forge a field
    // an attacker must start a NEW LINE inside a value, which requires "\n"
    // (and "\r" is rejected with it, defensively, so no CR-normalizing layer
    // between signer and verifier can manufacture one).
    //
    // "=" is NOT rejected. It cannot shift a field boundary here: the legacy
    // string is never PARSED — it is recomputed from `buildIntentFields`, whose
    // key set is a fixed hardcoded list ("plan", "uid", "idtype", "callback",
    // …). Forging via "=" would require a key like `plan=a` to exist, and no
    // such key can ever be produced. Rejecting "=" bought nothing and broke a
    // real case: `buildIntentFields` puts the DECODED callbackUrl into the
    // string, so ANY legacy intent whose callback carries a query string
    // (`?a=b`) started 401'ing — a brand-new failure mode on the very branch
    // whose purpose is to keep in-flight production intents working.
    const legacyFields = buildIntentFields({ ...input, idType: "tg" });
    if (legacyFields.some(([, value]) => value.includes("\n") || value.includes("\r"))) return false;
    const expectedLegacy = createHmac("sha256", config.checkoutSecret)
      .update(legacyFields.map(([key, value]) => `${key}=${value}`).join("\n"))
      .digest("hex");
    return timingSafeEqualStr(expectedLegacy, input.sig);
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
    /** Signed product id. Absent => DEFAULT_PRODUCT ("openclaw"). */
    product?: string;
    /** Signed checkout-intent amount (string, as signed). */
    amountUsd?: string;
    checkoutIntentVerified?: boolean;
  };

  async function finalizeVerifiedPayment(
    paymentId: string,
    result: { from: string; to: string; amountRaw: string; amountUsd: number; blockNumber?: number },
    ctx: VerificationContext,
  ): Promise<{ ok: true; payment: PaymentRecord | null } | { ok: false; error: string }> {
    const product = productConfig(config, ctx.product);

    // Top-up flow (#29): require the on-chain amount to cover the pack price.
    const topupPrices = product.topupPrices;
    if (ctx.topup && ctx.topup in topupPrices && result.amountUsd < topupPrices[ctx.topup]) {
      await markPaymentFailed(appDb, paymentId);
      return { ok: false, error: `Underpaid: expected $${topupPrices[ctx.topup]}, got $${result.amountUsd}` };
    }

    // Plan flow (main): resolve & validate the plan against the verified amount,
    // against THIS product's price table only.
    const planId = resolveplan(result.amountUsd, config, ctx.product);
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

    // ── Send webhook callback ──
    //
    // Attempt ONCE inline, then persist the outcome so a failure is durable and
    // REDELIVERABLE. Before this, a 5xx or a brief consumer outage meant the
    // money was taken on-chain and the customer got nothing, forever, with only
    // a log line. `callback_state` now carries attempts / next_attempt_at /
    // terminal status, and `drainDueCallbacks` (below) retries it on a later
    // request — the only scheduler a request-scoped Edge Function can have.
    if (ctx.callbackUrl && config.callbackSecret && verified) {
      const outcome = await attemptCallback(
        ctx.callbackUrl,
        verified,
        {
          topup: ctx.topup,
          tenantType: ctx.tenantType,
          vmProvider: ctx.vmProvider,
          hostType: ctx.hostType,
          deploymentType: ctx.deploymentType,
          product: product.id,
        },
        product.callbackAllowlist,
      );
      const state = await recordCallbackAttempt(appDb, paymentId, ctx.callbackUrl, outcome);
      logDeliveryOutcome(paymentId, verified.tx_hash, ctx.callbackUrl, outcome, state);
    } else if (verified && !ctx.callbackUrl) {
      // No callback at all on a verified payment is also money-in-nothing-out.
      // Nothing to retry — there is no address to retry TO — so it goes
      // straight to the terminal `needs_attention` state an operator watches.
      console.error(
        `[PAYMENT-LOST] payment ${paymentId} is VERIFIED but carried NO callbackUrl — ` +
          `nothing will ever be provisioned for it.`,
      );
      await recordCallbackOutcome(appDb, paymentId, null, "no callbackUrl on the intent");
    }

    return { ok: true, payment: verified };
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
    // `?product=` scopes wallets/prices to that product. Absent => openclaw,
    // so the existing SPA sees exactly what it saw before.
    // Unknown product must not silently resolve to openclaw's wallets/prices:
    // the SPA reads this to decide WHERE TO SEND FUNDS.
    let p: ReturnType<typeof productConfig>;
    try {
      p = productConfig(config, c.req.query("product"));
    } catch {
      return c.json({ error: `Unknown product: ${c.req.query("product")}` }, 400);
    }
    return c.json({
      product: p.id,
      productName: p.name,
      productIconUrl: p.iconUrl,
      products: Object.keys(config.products),
      wallets: p.wallets,
      prices: p.prices,
      topupPrices: p.topupPrices,
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
      /** Product being paid for. Absent => "openclaw" (backward compatible). */
      product?: string;
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

    // Unknown product ids are rejected rather than silently coerced to
    // `openclaw`: a typo'd product must not be settled at another product's
    // prices. Absent is fine and means `openclaw`.
    if (body.product !== undefined && !(body.product in config.products)) {
      return c.json({ error: `Unknown product: ${body.product}` }, 400);
    }
    const productId = productConfig(config, body.product).id;

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
      ...(body.product ? { product: body.product } : {}),
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
      const result = await verifyTransfer(body.txHash, body.chainId, configForProduct(config, productId));

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
        product: productId,
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
        const meta0 = (payment.metadata ?? {}) as Record<string, unknown>;
        const metaProduct = typeof meta0.product === "string" ? meta0.product : undefined;
        // Re-validate the stored product on THIS path too. `productConfig` now
        // throws for an unknown id instead of coercing to openclaw, so removing
        // a product from `PRODUCTS` while payments are pending can no longer
        // silently re-verify them against openclaw's wallet and price table.
        // Rethrown out of the surrounding try/catch would be swallowed as a
        // transient RPC error, so it is surfaced explicitly as a 409 instead.
        let scopedConfig: Config;
        try {
          scopedConfig = configForProduct(config, metaProduct);
        } catch (e) {
          if (e instanceof UnknownProductError) {
            return c.json(
              { error: `Unknown product: ${e.productId}`, payment },
              409,
            );
          }
          throw e;
        }
        const result = await verifyTransfer(
          payment.tx_hash,
          payment.chain_id as ChainId,
          scopedConfig,
        );
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
            product: str(meta.product),
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
    // Cosmetic only (name/icon) — an unknown id must not 500 the manifest.
    const brand = productConfigOrDefault(config, c.req.query("product"));
    return c.json({
      url: baseUrl,
      name: brand.name,
      iconUrl: brand.iconUrl,
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
      service: `${productConfig(config, DEFAULT_PRODUCT).name} API`,
      docs: "/api/config",
      version: "1.0.0",
      products: Object.keys(config.products),
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

interface CallbackMetadata {
  topup?: string;
  tenantType?: string;
  vmProvider?: string;
  hostType?: string;
  deploymentType?: string;
  product?: string;
}

/**
 * One delivery attempt that NEVER throws — it classifies.
 *
 * The throwing `sendCallback` below is kept as the public/legacy surface, but
 * the retry machinery needs the *shape* of the failure (HTTP status vs network
 * error vs structurally-undeliverable), because that is what decides whether
 * retrying identical bytes could ever work.
 */
export async function attemptCallback(
  callbackUrl: string,
  payment: PaymentRecord,
  metadata: CallbackMetadata = {},
  allowlist: string[] = config.callbackAllowlist,
  nowMs: number = Date.now(),
): Promise<AttemptOutcome> {
  // ── SSRF guard: only POST to allowlisted HTTPS hosts. ──
  // All three failures below are `permanent`: no amount of retrying makes a
  // non-allowlisted host allowlisted. They must land in `needs_attention` so an
  // operator fixes the config, not in `pending` where they burn retries.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(callbackUrl);
  } catch {
    return { ok: false, error: `not a valid URL: ${callbackUrl}`, permanent: true };
  }
  if (parsedUrl.protocol !== "https:") {
    return { ok: false, error: `callback URL must use HTTPS: ${callbackUrl}`, permanent: true };
  }
  if (!allowlist.includes(parsedUrl.hostname)) {
    console.error(
      `[PAYMENT-LOST] sendCallback REFUSED for payment ${payment.id}: host ` +
        `"${parsedUrl.hostname}" is not in CALLBACK_URL_ALLOWLIST ` +
        `(${allowlist.join(", ")}). The payment is VERIFIED but the ` +
        `customer will receive NOTHING. Add the host to ` +
        `CALLBACK_URL_ALLOWLIST, or stop the caller from signing intents for it.`,
    );
    return {
      ok: false,
      error: `callback host "${parsedUrl.hostname}" is not allowlisted`,
      permanent: true,
    };
  }

  // ── Payload ──
  // Everything here is a pure function of the PAYMENT, so it is byte-identical
  // across attempts — most importantly `payment.txHash`, which is the key the
  // consumer dedupes on. Only `timestamp` (added by `buildSignedPayload`)
  // differs per attempt; see the long note in callback-delivery.ts for why that
  // is required rather than merely convenient.
  const { payload, timestamp } = buildSignedPayload(
    {
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
        // Always present so the consumer knows which product was paid for;
        // defaults to "openclaw", which is what every pre-existing caller is.
        product: metadata.product ?? DEFAULT_PRODUCT,
      },
    },
    nowMs,
  );

  const signature = await hmacSha256Hex(config.callbackSecret, payload);

  let resp: Response;
  try {
    resp = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": signature,
        "X-Timestamp": timestamp,
      },
      body: payload,
    });
  } catch (err) {
    // No response at all: DNS failure, connection refused, TLS error, timeout.
    // Always retryable — the consumer never saw the payload.
    return { ok: false, error: `network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      error: `callback POST returned ${resp.status} ${resp.statusText}`,
    };
  }
  return { ok: true };
}

/**
 * Make a delivery outcome findable by an operator.
 *
 * `[PAYMENT-STUCK]` + the txHash is the alert hook: a terminal, undelivered
 * callback means real money is sitting in our wallet with nothing credited, and
 * only a human can resolve it. The txHash is included because it is the one
 * identifier that is the same on-chain, in our DB, and in the consumer's.
 */
function logDeliveryOutcome(
  paymentId: string,
  txHash: string,
  callbackUrl: string | null,
  outcome: AttemptOutcome,
  state: CallbackDeliveryState | null,
): void {
  if (outcome.ok) {
    console.log(`Callback delivered for payment ${paymentId} (tx ${txHash})`);
    return;
  }
  if (state?.status === "needs_attention") {
    console.error(
      `[PAYMENT-STUCK] reason=${state.terminal_reason} payment=${paymentId} ` +
        `tx=${txHash} url=${callbackUrl} attempts=${state.attempts} ` +
        `lastStatus=${state.last_status} lastError=${outcome.error}. ` +
        `The payment is VERIFIED and will NOT be retried again. ` +
        `A human must credit this customer manually.`,
    );
    return;
  }
  console.warn(
    `[PAYMENT-RETRY] payment=${paymentId} tx=${txHash} attempt=${state?.attempts ?? "?"} ` +
      `nextAttemptAt=${state?.next_attempt_at ?? "?"} error=${outcome.error}`,
  );
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
