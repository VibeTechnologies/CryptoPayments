import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

export function createDB(dbPath: string): DB {
  // Ensure directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Who paid: telegram user ID or email
      id_type TEXT NOT NULL CHECK (id_type IN ('tg', 'email')),
      uid TEXT NOT NULL,
      -- What they paid
      tx_hash TEXT NOT NULL,
      chain_id TEXT NOT NULL CHECK (chain_id IN ('base', 'eth', 'ton', 'sol')),
      token TEXT NOT NULL CHECK (token IN ('usdt', 'usdc')),
      amount_raw TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      -- Verification
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed')),
      verified_at INTEGER,
      -- Which plan this payment is for (optional, resolved by amount)
      plan_id TEXT,
      -- Metadata
      from_address TEXT,
      to_address TEXT,
      block_number INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      -- Prevent duplicate tx submissions
      UNIQUE(tx_hash, chain_id)
    );

    CREATE INDEX IF NOT EXISTS idx_payments_uid ON payments(id_type, uid);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_payments_tx ON payments(tx_hash, chain_id);
  `);

  return db;
}

export interface PaymentRecord {
  id: number;
  id_type: "tg" | "email";
  uid: string;
  tx_hash: string;
  chain_id: string;
  token: string;
  amount_raw: string;
  amount_usd: number;
  status: "pending" | "verified" | "failed";
  verified_at: number | null;
  plan_id: string | null;
  from_address: string | null;
  to_address: string | null;
  block_number: number | null;
  created_at: number;
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

export function insertPayment(db: DB, p: InsertPayment): PaymentRecord {
  const stmt = db.prepare(`
    INSERT INTO payments (id_type, uid, tx_hash, chain_id, token, amount_raw, amount_usd, plan_id, from_address, to_address, block_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    p.idType,
    p.uid,
    p.txHash,
    p.chainId,
    p.token,
    p.amountRaw,
    p.amountUsd,
    p.planId ?? null,
    p.fromAddress ?? null,
    p.toAddress ?? null,
    p.blockNumber ?? null,
  );
  return getPaymentById(db, result.lastInsertRowid as number)!;
}

export function getPaymentById(db: DB, id: number): PaymentRecord | null {
  return (db.prepare("SELECT * FROM payments WHERE id = ?").get(id) as PaymentRecord | undefined) ?? null;
}

export function getPaymentByTx(db: DB, txHash: string, chainId: string): PaymentRecord | null {
  return (db.prepare("SELECT * FROM payments WHERE tx_hash = ? AND chain_id = ?").get(txHash, chainId) as PaymentRecord | undefined) ?? null;
}

export function getPaymentsByUser(db: DB, idType: string, uid: string): PaymentRecord[] {
  return db.prepare("SELECT * FROM payments WHERE id_type = ? AND uid = ? ORDER BY created_at DESC").all(idType, uid) as PaymentRecord[];
}

export function markPaymentVerified(
  db: DB,
  id: number,
  details: { fromAddress: string; toAddress: string; amountRaw: string; amountUsd: number; blockNumber?: number; planId?: string },
): void {
  db.prepare(`
    UPDATE payments
    SET status = 'verified',
        verified_at = unixepoch(),
        from_address = ?,
        to_address = ?,
        amount_raw = ?,
        amount_usd = ?,
        block_number = ?,
        plan_id = ?
    WHERE id = ?
  `).run(
    details.fromAddress,
    details.toAddress,
    details.amountRaw,
    details.amountUsd,
    details.blockNumber ?? null,
    details.planId ?? null,
    id,
  );
}

export function markPaymentFailed(db: DB, id: number): void {
  db.prepare("UPDATE payments SET status = 'failed' WHERE id = ?").run(id);
}
