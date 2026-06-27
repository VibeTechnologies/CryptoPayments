-- ============================================================================
-- Migration: 20260626140000_rls_service_role_only
-- Scope existing RLS policies to service_role only.
--
-- Why: the previous "FOR ALL USING (true)" policies were permissive for ALL
-- roles, including anon and authenticated (public). Although service_role
-- bypasses RLS entirely, the open USING clause implicitly granted read/write
-- access to any Supabase client with an anon or user JWT — a privilege we
-- do not intend to grant. Scoping to TO service_role removes that implicit
-- grant while keeping the service (which uses the service_role key) fully
-- functional.
-- ============================================================================

-- customers
DROP POLICY IF EXISTS service_all ON customers;
CREATE POLICY service_all ON customers FOR ALL TO service_role USING (true) WITH CHECK (true);

-- invoices
DROP POLICY IF EXISTS service_all ON invoices;
CREATE POLICY service_all ON invoices FOR ALL TO service_role USING (true) WITH CHECK (true);

-- invoice_line_items
DROP POLICY IF EXISTS service_all ON invoice_line_items;
CREATE POLICY service_all ON invoice_line_items FOR ALL TO service_role USING (true) WITH CHECK (true);

-- payment_intents
DROP POLICY IF EXISTS service_all ON payment_intents;
CREATE POLICY service_all ON payment_intents FOR ALL TO service_role USING (true) WITH CHECK (true);

-- checkout_sessions
DROP POLICY IF EXISTS service_all ON checkout_sessions;
CREATE POLICY service_all ON checkout_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- webhook_events
DROP POLICY IF EXISTS service_all ON webhook_events;
CREATE POLICY service_all ON webhook_events FOR ALL TO service_role USING (true) WITH CHECK (true);
