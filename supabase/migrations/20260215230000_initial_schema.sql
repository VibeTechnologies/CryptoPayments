-- ============================================================================
-- CryptoPayments Supabase Schema
-- Stripe-like data model for crypto payment processing
-- ============================================================================
-- Run this in Supabase SQL Editor to create all tables.
-- All tables use UUID primary keys + Stripe-style prefixed IDs for external use.
-- ============================================================================

-- ── Helper: generate Stripe-style prefixed IDs ──────────────────────────────
CREATE OR REPLACE FUNCTION generate_prefixed_id(prefix text)
RETURNS text AS $$
  SELECT prefix || '_' || replace(gen_random_uuid()::text, '-', '')
$$ LANGUAGE sql;

-- ── Updated_at trigger function ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Customers ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_id     text UNIQUE NOT NULL DEFAULT generate_prefixed_id('cus'),
  id_type       text NOT NULL CHECK (id_type IN ('tg', 'email')),
  uid           text NOT NULL,
  name          text,
  email         text,
  metadata      jsonb DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id_type, uid)
);

CREATE INDEX IF NOT EXISTS idx_customers_identity ON customers(id_type, uid);

CREATE TRIGGER trg_customers_updated
  BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Invoices ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_id       text UNIQUE NOT NULL DEFAULT generate_prefixed_id('inv'),
  customer_id     uuid NOT NULL REFERENCES customers(id),
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  currency        text NOT NULL DEFAULT 'usd',
  subtotal        integer NOT NULL DEFAULT 0,
  tax             integer NOT NULL DEFAULT 0,
  total           integer NOT NULL DEFAULT 0,
  amount_paid     integer NOT NULL DEFAULT 0,
  amount_remaining integer NOT NULL DEFAULT 0,
  due_date        timestamptz,
  paid_at         timestamptz,
  voided_at       timestamptz,
  payment_intent_id uuid,
  plan_id         text,
  description     text,
  footer          text,
  metadata        jsonb DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

CREATE TRIGGER trg_invoices_updated
  BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Invoice Line Items ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_line_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_id     text UNIQUE NOT NULL DEFAULT generate_prefixed_id('il'),
  invoice_id    uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description   text NOT NULL,
  amount        integer NOT NULL,
  quantity      integer NOT NULL DEFAULT 1,
  metadata      jsonb DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_line_items_invoice ON invoice_line_items(invoice_id);

-- ── Payment Intents ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_intents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_id       text UNIQUE NOT NULL DEFAULT generate_prefixed_id('pi'),
  customer_id     uuid REFERENCES customers(id),
  invoice_id      uuid REFERENCES invoices(id),
  amount          integer NOT NULL,
  currency        text NOT NULL DEFAULT 'usd',
  status          text NOT NULL DEFAULT 'requires_payment_method'
                    CHECK (status IN (
                      'requires_payment_method',
                      'processing',
                      'succeeded',
                      'failed',
                      'canceled'
                    )),
  chain_id        text CHECK (chain_id IS NULL OR chain_id IN ('base', 'eth', 'ton', 'sol')),
  token           text CHECK (token IS NULL OR token IN ('usdt', 'usdc')),
  tx_hash         text,
  from_address    text,
  to_address      text,
  block_number    bigint,
  amount_raw      text,
  plan_id         text,
  description     text,
  metadata        jsonb DEFAULT '{}'::jsonb,
  succeeded_at    timestamptz,
  canceled_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tx_hash, chain_id)
);

CREATE INDEX IF NOT EXISTS idx_pi_customer ON payment_intents(customer_id);
CREATE INDEX IF NOT EXISTS idx_pi_invoice ON payment_intents(invoice_id);
CREATE INDEX IF NOT EXISTS idx_pi_status ON payment_intents(status);
CREATE INDEX IF NOT EXISTS idx_pi_tx ON payment_intents(tx_hash, chain_id);

CREATE TRIGGER trg_pi_updated
  BEFORE UPDATE ON payment_intents FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Checkout Sessions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_id         text UNIQUE NOT NULL DEFAULT generate_prefixed_id('cs'),
  customer_id       uuid REFERENCES customers(id),
  invoice_id        uuid REFERENCES invoices(id),
  payment_intent_id uuid REFERENCES payment_intents(id),
  status            text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'complete', 'expired')),
  plan_id           text,
  amount            integer NOT NULL,
  currency          text NOT NULL DEFAULT 'usd',
  success_url       text,
  cancel_url        text,
  callback_url      text,
  url               text,
  expires_at        timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  completed_at      timestamptz,
  metadata          jsonb DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cs_customer ON checkout_sessions(customer_id);
CREATE INDEX IF NOT EXISTS idx_cs_status ON checkout_sessions(status);

CREATE TRIGGER trg_cs_updated
  BEFORE UPDATE ON checkout_sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Webhook Events ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_id     text UNIQUE NOT NULL DEFAULT generate_prefixed_id('evt'),
  type          text NOT NULL,
  data          jsonb NOT NULL,
  delivered     boolean NOT NULL DEFAULT false,
  delivered_at  timestamptz,
  delivery_attempts integer NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_type ON webhook_events(type);
CREATE INDEX IF NOT EXISTS idx_events_created ON webhook_events(created_at DESC);

-- ── Row Level Security ──────────────────────────────────────────────────────
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkout_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS. These permissive policies ensure
-- the server (using service_role key) can access everything.
CREATE POLICY service_all ON customers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY service_all ON invoices FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY service_all ON invoice_line_items FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY service_all ON payment_intents FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY service_all ON checkout_sessions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY service_all ON webhook_events FOR ALL USING (true) WITH CHECK (true);
