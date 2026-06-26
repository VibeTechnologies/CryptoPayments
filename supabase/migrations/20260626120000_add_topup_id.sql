-- ── Add topup_id to payment_intents ─────────────────────────────────────────
-- Adds the topup_id column so that top-up flows can associate a payment intent
-- with an external top-up reference. Mirrors plan_id: nullable text, no default.
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS topup_id text;
