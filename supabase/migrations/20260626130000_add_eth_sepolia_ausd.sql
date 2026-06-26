-- ── Add eth_sepolia chain + agentUSD (ausd) token ───────────────────────────
-- agentUSD is a supply-controlled testnet ERC-20 on Ethereum Sepolia
-- (0x76B2AeC049e93FB53f210a4B0f02fe3Dee6514C3). Minting is owner-only, so the
-- token cannot be acquired by third parties — safe to recognize as a payment
-- token in prod. Enables on-demand + automated crypto-payment testing.
--
-- The inline CHECK constraints in schema.sql are auto-named by Postgres as
-- <table>_<column>_check. DROP IF EXISTS + re-ADD widens the allowed set.
ALTER TABLE payment_intents
  DROP CONSTRAINT IF EXISTS payment_intents_chain_id_check,
  ADD  CONSTRAINT payment_intents_chain_id_check
       CHECK (chain_id IS NULL OR chain_id IN ('base','eth','ton','sol','base_sepolia','eth_sepolia'));

ALTER TABLE payment_intents
  DROP CONSTRAINT IF EXISTS payment_intents_token_check,
  ADD  CONSTRAINT payment_intents_token_check
       CHECK (token IS NULL OR token IN ('usdt','usdc','ausd'));
