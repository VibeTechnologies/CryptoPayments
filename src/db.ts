import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ── Types ────────────────────────────────────────────────────────────────────

export type DB = SupabaseClient;

export interface CustomerRecord {
  id: string;
  stripe_id: string;
  id_type: "tg" | "email";
  uid: string;
  name: string | null;
  email: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface InvoiceRecord {
  id: string;
  stripe_id: string;
  customer_id: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  amount_paid: number;
  amount_remaining: number;
  due_date: string | null;
  paid_at: string | null;
  voided_at: string | null;
  payment_intent_id: string | null;
  plan_id: string | null;
  description: string | null;
  footer: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface InvoiceLineItemRecord {
  id: string;
  stripe_id: string;
  invoice_id: string;
  description: string;
  amount: number;
  quantity: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface PaymentIntentRecord {
  id: string;
  stripe_id: string;
  customer_id: string | null;
  invoice_id: string | null;
  amount: number;
  currency: string;
  status: "requires_payment_method" | "processing" | "succeeded" | "failed" | "canceled";
  chain_id: string | null;
  token: string | null;
  tx_hash: string | null;
  from_address: string | null;
  to_address: string | null;
  block_number: number | null;
  amount_raw: string | null;
  plan_id: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  succeeded_at: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CheckoutSessionRecord {
  id: string;
  stripe_id: string;
  customer_id: string | null;
  invoice_id: string | null;
  payment_intent_id: string | null;
  status: "open" | "complete" | "expired";
  plan_id: string | null;
  amount: number;
  currency: string;
  success_url: string | null;
  cancel_url: string | null;
  callback_url: string | null;
  url: string | null;
  expires_at: string;
  completed_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WebhookEventRecord {
  id: string;
  stripe_id: string;
  type: string;
  data: Record<string, unknown>;
  delivered: boolean;
  delivered_at: string | null;
  delivery_attempts: number;
  last_error: string | null;
  created_at: string;
}

// ── Legacy compat: maps to old PaymentRecord shape ───────────────────────────

export interface PaymentRecord {
  id: string;
  id_type: "tg" | "email";
  uid: string;
  tx_hash: string;
  chain_id: string;
  token: string;
  amount_raw: string;
  amount_usd: number;
  status: "pending" | "verified" | "failed";
  verified_at: string | null;
  plan_id: string | null;
  from_address: string | null;
  to_address: string | null;
  block_number: number | null;
  created_at: string;
}

export interface InsertPayment {
  idType: "tg" | "email";
  uid: string;
  txHash: string;
  chainId: string;
  token: string;
  amountRaw: string;
  amountUsd: number;
  planId?: string;
  fromAddress?: string;
  toAddress?: string;
  blockNumber?: number;
}

// ── Prefix ID generation (client-side fallback) ──────────────────────────────

function prefixedId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

// ── Stripe-ID → UUID resolver ────────────────────────────────────────────────

const STRIPE_PREFIX_TABLE: Record<string, string> = {
  cus_: "customers",
  inv_: "invoices",
  pi_: "payment_intents",
  cs_: "checkout_sessions",
};

/**
 * Resolve a Stripe-style prefixed ID (e.g. cus_abc123) to the row's UUID.
 * If already a UUID, returns it as-is. Returns null if not found.
 */
async function resolveToUuid(db: DB, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const prefix = Object.keys(STRIPE_PREFIX_TABLE).find((p) => id.startsWith(p));
  if (!prefix) return id; // Already a UUID
  const table = STRIPE_PREFIX_TABLE[prefix];
  const { data } = await db.from(table).select("id").eq("stripe_id", id).single();
  return data?.id ?? null;
}

// ── Database client ──────────────────────────────────────────────────────────

export function createDB(supabaseUrl: string, supabaseKey: string): DB {
  return createClient(supabaseUrl, supabaseKey);
}

// ── Customers ────────────────────────────────────────────────────────────────

export async function getOrCreateCustomer(
  db: DB,
  idType: "tg" | "email",
  uid: string,
): Promise<CustomerRecord> {
  // Try to find existing customer
  const { data: existing } = await db
    .from("customers")
    .select("*")
    .eq("id_type", idType)
    .eq("uid", uid)
    .single();

  if (existing) return existing as CustomerRecord;

  // Create new customer
  const { data, error } = await db
    .from("customers")
    .insert({ id_type: idType, uid, stripe_id: prefixedId("cus") })
    .select("*")
    .single();

  if (error) throw new Error(`Failed to create customer: ${error.message}`);
  return data as CustomerRecord;
}

export async function getCustomerById(db: DB, id: string): Promise<CustomerRecord | null> {
  // Support both UUID and stripe_id (cus_...)
  const column = id.startsWith("cus_") ? "stripe_id" : "id";
  const { data } = await db.from("customers").select("*").eq(column, id).single();
  return (data as CustomerRecord) ?? null;
}

export async function updateCustomer(
  db: DB,
  id: string,
  updates: { name?: string; email?: string; metadata?: Record<string, unknown> },
): Promise<CustomerRecord | null> {
  const column = id.startsWith("cus_") ? "stripe_id" : "id";
  const { data, error } = await db.from("customers").update(updates).eq(column, id).select("*").single();
  if (error) throw new Error(`Failed to update customer: ${error.message}`);
  return (data as CustomerRecord) ?? null;
}

export async function listCustomers(
  db: DB,
  opts: { limit?: number; offset?: number } = {},
): Promise<CustomerRecord[]> {
  const limit = opts.limit ?? 10;
  const offset = opts.offset ?? 0;
  const { data } = await db
    .from("customers")
    .select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  return (data as CustomerRecord[]) ?? [];
}

// ── Invoices ─────────────────────────────────────────────────────────────────

export async function createInvoice(
  db: DB,
  input: {
    customerId: string;
    planId?: string;
    description?: string;
    footer?: string;
    metadata?: Record<string, unknown>;
    dueDate?: string;
  },
): Promise<InvoiceRecord> {
  const { data, error } = await db
    .from("invoices")
    .insert({
      stripe_id: prefixedId("inv"),
      customer_id: input.customerId,
      plan_id: input.planId ?? null,
      description: input.description ?? null,
      footer: input.footer ?? null,
      metadata: input.metadata ?? {},
      due_date: input.dueDate ?? null,
    })
    .select("*")
    .single();

  if (error) throw new Error(`Failed to create invoice: ${error.message}`);
  return data as InvoiceRecord;
}

export async function getInvoiceById(db: DB, id: string): Promise<InvoiceRecord | null> {
  const column = id.startsWith("inv_") ? "stripe_id" : "id";
  const { data } = await db.from("invoices").select("*").eq(column, id).single();
  return (data as InvoiceRecord) ?? null;
}

export async function getInvoiceWithLineItems(
  db: DB,
  id: string,
): Promise<(InvoiceRecord & { line_items: InvoiceLineItemRecord[] }) | null> {
  const column = id.startsWith("inv_") ? "stripe_id" : "id";
  const { data } = await db
    .from("invoices")
    .select("*, invoice_line_items(*)")
    .eq(column, id)
    .single();

  if (!data) return null;
  const { invoice_line_items, ...invoice } = data as InvoiceRecord & { invoice_line_items: InvoiceLineItemRecord[] };
  return { ...invoice, line_items: invoice_line_items ?? [] };
}

export async function listInvoices(
  db: DB,
  opts: { customerId?: string; status?: string; limit?: number; offset?: number } = {},
): Promise<InvoiceRecord[]> {
  const limit = opts.limit ?? 10;
  const offset = opts.offset ?? 0;
  let query = db.from("invoices").select("*").order("created_at", { ascending: false });

  if (opts.customerId) query = query.eq("customer_id", opts.customerId);
  if (opts.status) query = query.eq("status", opts.status);

  const { data } = await query.range(offset, offset + limit - 1);
  return (data as InvoiceRecord[]) ?? [];
}

export async function addInvoiceLineItem(
  db: DB,
  invoiceId: string,
  item: { description: string; amount: number; quantity?: number; metadata?: Record<string, unknown> },
): Promise<InvoiceLineItemRecord> {
  // Resolve invoice UUID
  const invoice = await getInvoiceById(db, invoiceId);
  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status !== "draft") throw new Error("Can only add line items to draft invoices");

  const { data, error } = await db
    .from("invoice_line_items")
    .insert({
      stripe_id: prefixedId("il"),
      invoice_id: invoice.id,
      description: item.description,
      amount: item.amount,
      quantity: item.quantity ?? 1,
      metadata: item.metadata ?? {},
    })
    .select("*")
    .single();

  if (error) throw new Error(`Failed to add line item: ${error.message}`);

  // Recalculate invoice totals
  await recalculateInvoiceTotals(db, invoice.id);

  return data as InvoiceLineItemRecord;
}

async function recalculateInvoiceTotals(db: DB, invoiceId: string): Promise<void> {
  const { data: items } = await db
    .from("invoice_line_items")
    .select("amount, quantity")
    .eq("invoice_id", invoiceId);

  const subtotal = (items ?? []).reduce(
    (sum: number, item: { amount: number; quantity: number }) => sum + item.amount * item.quantity,
    0,
  );
  const total = subtotal; // No tax for crypto payments

  await db
    .from("invoices")
    .update({
      subtotal,
      total,
      amount_remaining: total,
    })
    .eq("id", invoiceId);
}

export async function finalizeInvoice(db: DB, invoiceId: string): Promise<InvoiceRecord> {
  const invoice = await getInvoiceById(db, invoiceId);
  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status !== "draft") throw new Error("Can only finalize draft invoices");

  const { data, error } = await db
    .from("invoices")
    .update({ status: "open" })
    .eq("id", invoice.id)
    .select("*")
    .single();

  if (error) throw new Error(`Failed to finalize invoice: ${error.message}`);
  return data as InvoiceRecord;
}

export async function voidInvoice(db: DB, invoiceId: string): Promise<InvoiceRecord> {
  const invoice = await getInvoiceById(db, invoiceId);
  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status !== "open") throw new Error("Can only void open invoices");

  const { data, error } = await db
    .from("invoices")
    .update({ status: "void", voided_at: new Date().toISOString() })
    .eq("id", invoice.id)
    .select("*")
    .single();

  if (error) throw new Error(`Failed to void invoice: ${error.message}`);
  return data as InvoiceRecord;
}

export async function markInvoicePaid(
  db: DB,
  invoiceId: string,
  paymentIntentId: string,
): Promise<InvoiceRecord> {
  const invoice = await getInvoiceById(db, invoiceId);
  if (!invoice) throw new Error("Invoice not found");

  const { data, error } = await db
    .from("invoices")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      payment_intent_id: paymentIntentId,
      amount_paid: invoice.total,
      amount_remaining: 0,
    })
    .eq("id", invoice.id)
    .select("*")
    .single();

  if (error) throw new Error(`Failed to mark invoice paid: ${error.message}`);
  return data as InvoiceRecord;
}

// ── Payment Intents ──────────────────────────────────────────────────────────

export async function createPaymentIntent(
  db: DB,
  input: {
    customerId?: string;
    invoiceId?: string;
    amount: number;
    chainId?: string;
    token?: string;
    planId?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<PaymentIntentRecord> {
  // Resolve stripe_ids (cus_..., inv_...) to UUIDs for FK columns
  const customerId = await resolveToUuid(db, input.customerId);
  const invoiceId = await resolveToUuid(db, input.invoiceId);

  const { data, error } = await db
    .from("payment_intents")
    .insert({
      stripe_id: prefixedId("pi"),
      customer_id: customerId,
      invoice_id: invoiceId,
      amount: input.amount,
      chain_id: input.chainId ?? null,
      token: input.token ?? null,
      plan_id: input.planId ?? null,
      description: input.description ?? null,
      metadata: input.metadata ?? {},
    })
    .select("*")
    .single();

  if (error) throw new Error(`Failed to create payment intent: ${error.message}`);
  return data as PaymentIntentRecord;
}

export async function getPaymentIntentById(db: DB, id: string): Promise<PaymentIntentRecord | null> {
  const column = id.startsWith("pi_") ? "stripe_id" : "id";
  const { data } = await db.from("payment_intents").select("*").eq(column, id).single();
  return (data as PaymentIntentRecord) ?? null;
}

export async function getPaymentIntentByTx(
  db: DB,
  txHash: string,
  chainId: string,
): Promise<PaymentIntentRecord | null> {
  const { data } = await db
    .from("payment_intents")
    .select("*")
    .eq("tx_hash", txHash)
    .eq("chain_id", chainId)
    .single();
  return (data as PaymentIntentRecord) ?? null;
}

export async function listPaymentIntents(
  db: DB,
  opts: { customerId?: string; status?: string; limit?: number; offset?: number } = {},
): Promise<PaymentIntentRecord[]> {
  const limit = opts.limit ?? 10;
  const offset = opts.offset ?? 0;
  let query = db.from("payment_intents").select("*").order("created_at", { ascending: false });

  if (opts.customerId) query = query.eq("customer_id", opts.customerId);
  if (opts.status) query = query.eq("status", opts.status);

  const { data } = await query.range(offset, offset + limit - 1);
  return (data as PaymentIntentRecord[]) ?? [];
}

export async function updatePaymentIntentStatus(
  db: DB,
  id: string,
  status: PaymentIntentRecord["status"],
  details?: {
    txHash?: string;
    chainId?: string;
    token?: string;
    fromAddress?: string;
    toAddress?: string;
    amountRaw?: string;
    blockNumber?: number;
    planId?: string;
  },
): Promise<PaymentIntentRecord> {
  const updates: Record<string, unknown> = { status };
  if (details?.txHash) updates.tx_hash = details.txHash;
  if (details?.chainId) updates.chain_id = details.chainId;
  if (details?.token) updates.token = details.token;
  if (details?.fromAddress) updates.from_address = details.fromAddress;
  if (details?.toAddress) updates.to_address = details.toAddress;
  if (details?.amountRaw) updates.amount_raw = details.amountRaw;
  if (details?.blockNumber) updates.block_number = details.blockNumber;
  if (details?.planId) updates.plan_id = details.planId;
  if (status === "succeeded") updates.succeeded_at = new Date().toISOString();
  if (status === "canceled") updates.canceled_at = new Date().toISOString();

  const column = id.startsWith("pi_") ? "stripe_id" : "id";
  const { data, error } = await db
    .from("payment_intents")
    .update(updates)
    .eq(column, id)
    .select("*")
    .single();

  if (error) throw new Error(`Failed to update payment intent: ${error.message}`);
  return data as PaymentIntentRecord;
}

// ── Checkout Sessions ────────────────────────────────────────────────────────

export async function createCheckoutSession(
  db: DB,
  input: {
    customerId?: string;
    invoiceId?: string;
    paymentIntentId?: string;
    planId?: string;
    amount: number;
    successUrl?: string;
    cancelUrl?: string;
    callbackUrl?: string;
    metadata?: Record<string, unknown>;
    expiresInMinutes?: number;
  },
  baseUrl: string,
): Promise<CheckoutSessionRecord> {
  const stripeId = prefixedId("cs");
  const expiresAt = new Date(Date.now() + (input.expiresInMinutes ?? 30) * 60 * 1000).toISOString();
  const url = `${baseUrl}/checkout/${stripeId}`;

  // Resolve stripe_ids (cus_..., inv_..., pi_...) to UUIDs for FK columns
  const customerId = await resolveToUuid(db, input.customerId);
  const invoiceId = await resolveToUuid(db, input.invoiceId);
  const paymentIntentId = await resolveToUuid(db, input.paymentIntentId);

  const { data, error } = await db
    .from("checkout_sessions")
    .insert({
      stripe_id: stripeId,
      customer_id: customerId,
      invoice_id: invoiceId,
      payment_intent_id: paymentIntentId,
      plan_id: input.planId ?? null,
      amount: input.amount,
      success_url: input.successUrl ?? null,
      cancel_url: input.cancelUrl ?? null,
      callback_url: input.callbackUrl ?? null,
      url,
      expires_at: expiresAt,
      metadata: input.metadata ?? {},
    })
    .select("*")
    .single();

  if (error) throw new Error(`Failed to create checkout session: ${error.message}`);
  return data as CheckoutSessionRecord;
}

export async function getCheckoutSessionById(db: DB, id: string): Promise<CheckoutSessionRecord | null> {
  const column = id.startsWith("cs_") ? "stripe_id" : "id";
  const { data } = await db.from("checkout_sessions").select("*").eq(column, id).single();
  return (data as CheckoutSessionRecord) ?? null;
}

export async function completeCheckoutSession(
  db: DB,
  id: string,
  paymentIntentId: string,
): Promise<CheckoutSessionRecord> {
  const column = id.startsWith("cs_") ? "stripe_id" : "id";
  const resolvedPiId = await resolveToUuid(db, paymentIntentId);
  const { data, error } = await db
    .from("checkout_sessions")
    .update({
      status: "complete",
      payment_intent_id: resolvedPiId,
      completed_at: new Date().toISOString(),
    })
    .eq(column, id)
    .select("*")
    .single();

  if (error) throw new Error(`Failed to complete checkout session: ${error.message}`);
  return data as CheckoutSessionRecord;
}

// ── Webhook Events ───────────────────────────────────────────────────────────

export async function createWebhookEvent(
  db: DB,
  type: string,
  eventData: Record<string, unknown>,
): Promise<WebhookEventRecord> {
  const { data, error } = await db
    .from("webhook_events")
    .insert({
      stripe_id: prefixedId("evt"),
      type,
      data: eventData,
    })
    .select("*")
    .single();

  if (error) throw new Error(`Failed to create webhook event: ${error.message}`);
  return data as WebhookEventRecord;
}

export async function markEventDelivered(
  db: DB,
  eventId: string,
  deliveryError?: string,
): Promise<void> {
  const updates: Record<string, unknown> = {
    delivery_attempts: 1,
  };

  if (deliveryError) {
    updates.last_error = deliveryError;
  } else {
    updates.delivered = true;
    updates.delivered_at = new Date().toISOString();
  }

  await db.from("webhook_events").update(updates).eq("id", eventId);
}

export async function listWebhookEvents(
  db: DB,
  opts: { type?: string; limit?: number; offset?: number } = {},
): Promise<WebhookEventRecord[]> {
  const limit = opts.limit ?? 10;
  const offset = opts.offset ?? 0;
  let query = db.from("webhook_events").select("*").order("created_at", { ascending: false });

  if (opts.type) query = query.eq("type", opts.type);

  const { data } = await query.range(offset, offset + limit - 1);
  return (data as WebhookEventRecord[]) ?? [];
}

// ── Legacy compatibility layer ───────────────────────────────────────────────
// These functions provide backward compatibility with the old SQLite-based API.

/**
 * Insert a payment using the legacy format.
 * Creates a customer (if needed) and a payment intent, returns a PaymentRecord.
 */
export async function insertPayment(db: DB, p: InsertPayment): Promise<PaymentRecord> {
  const customer = await getOrCreateCustomer(db, p.idType, p.uid);
  const amountCents = Math.round(p.amountUsd * 100);

  const pi = await createPaymentIntent(db, {
    customerId: customer.id,
    amount: amountCents,
    chainId: p.chainId,
    token: p.token,
    planId: p.planId,
  });

  // Set tx_hash and metadata directly
  if (p.txHash) {
    await db
      .from("payment_intents")
      .update({
        tx_hash: p.txHash,
        from_address: p.fromAddress ?? null,
        to_address: p.toAddress ?? null,
        block_number: p.blockNumber ?? null,
        amount_raw: p.amountRaw,
      })
      .eq("id", pi.id);
  }

  return piToPaymentRecord(
    { ...pi, tx_hash: p.txHash, from_address: p.fromAddress ?? null, to_address: p.toAddress ?? null, block_number: p.blockNumber ?? null, amount_raw: p.amountRaw },
    customer,
  );
}

export async function getPaymentById(db: DB, id: string): Promise<PaymentRecord | null> {
  const pi = await getPaymentIntentById(db, id);
  if (!pi || !pi.customer_id) return null;
  const customer = await getCustomerById(db, pi.customer_id);
  if (!customer) return null;
  return piToPaymentRecord(pi, customer);
}

export async function getPaymentByTx(db: DB, txHash: string, chainId: string): Promise<PaymentRecord | null> {
  const pi = await getPaymentIntentByTx(db, txHash, chainId);
  if (!pi || !pi.customer_id) return null;
  const customer = await getCustomerById(db, pi.customer_id);
  if (!customer) return null;
  return piToPaymentRecord(pi, customer);
}

export async function getPaymentsByUser(db: DB, idType: string, uid: string): Promise<PaymentRecord[]> {
  const { data: customer } = await db
    .from("customers")
    .select("*")
    .eq("id_type", idType)
    .eq("uid", uid)
    .single();

  if (!customer) return [];

  const pis = await listPaymentIntents(db, { customerId: customer.id, limit: 100 });
  return pis.map((pi) => piToPaymentRecord(pi, customer as CustomerRecord));
}

export async function markPaymentVerified(
  db: DB,
  id: string,
  details: { fromAddress: string; toAddress: string; amountRaw: string; amountUsd: number; blockNumber?: number; planId?: string },
): Promise<void> {
  await updatePaymentIntentStatus(db, id, "succeeded", {
    fromAddress: details.fromAddress,
    toAddress: details.toAddress,
    amountRaw: details.amountRaw,
    blockNumber: details.blockNumber,
    planId: details.planId,
  });

  // Update amount in cents
  await db
    .from("payment_intents")
    .update({ amount: Math.round(details.amountUsd * 100) })
    .eq(id.startsWith("pi_") ? "stripe_id" : "id", id);
}

export async function markPaymentFailed(db: DB, id: string): Promise<void> {
  await updatePaymentIntentStatus(db, id, "failed");
}

/** Convert a PaymentIntentRecord + CustomerRecord to the legacy PaymentRecord shape */
function piToPaymentRecord(pi: PaymentIntentRecord, customer: CustomerRecord): PaymentRecord {
  return {
    id: pi.stripe_id,
    id_type: customer.id_type,
    uid: customer.uid,
    tx_hash: pi.tx_hash ?? "",
    chain_id: pi.chain_id ?? "",
    token: pi.token ?? "",
    amount_raw: pi.amount_raw ?? "0",
    amount_usd: pi.amount / 100,
    status: pi.status === "succeeded" ? "verified" : pi.status === "failed" ? "failed" : "pending",
    verified_at: pi.succeeded_at,
    plan_id: pi.plan_id,
    from_address: pi.from_address,
    to_address: pi.to_address,
    block_number: pi.block_number,
    created_at: pi.created_at,
  };
}
