import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDB, insertPayment, getPaymentById, getPaymentByTx, getPaymentsByUser, markPaymentVerified, markPaymentFailed, type DB } from "../src/db.js";
import { resolveplan } from "../src/verify.js";
import { unlinkSync } from "node:fs";

const TEST_DB = "./data/test-payments.db";

describe("Database", () => {
  let db: DB;

  beforeEach(() => {
    db = createDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  it("creates tables on init", () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("payments");
  });

  it("inserts and retrieves a payment", () => {
    const payment = insertPayment(db, {
      idType: "tg",
      uid: "123456",
      txHash: "0xabc123",
      chainId: "base",
      token: "usdc",
      amountRaw: "10000000",
      amountUsd: 10,
    });

    expect(payment.id).toBeDefined();
    expect(payment.status).toBe("pending");
    expect(payment.id_type).toBe("tg");
    expect(payment.uid).toBe("123456");
    expect(payment.chain_id).toBe("base");

    const fetched = getPaymentById(db, payment.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.tx_hash).toBe("0xabc123");
  });

  it("prevents duplicate tx_hash + chain_id", () => {
    insertPayment(db, {
      idType: "tg",
      uid: "123456",
      txHash: "0xabc123",
      chainId: "base",
      token: "usdc",
      amountRaw: "10000000",
      amountUsd: 10,
    });

    expect(() =>
      insertPayment(db, {
        idType: "tg",
        uid: "999",
        txHash: "0xabc123",
        chainId: "base",
        token: "usdt",
        amountRaw: "25000000",
        amountUsd: 25,
      }),
    ).toThrow();
  });

  it("allows same tx_hash on different chains", () => {
    insertPayment(db, {
      idType: "tg",
      uid: "123",
      txHash: "0xabc",
      chainId: "base",
      token: "usdc",
      amountRaw: "10000000",
      amountUsd: 10,
    });

    const p2 = insertPayment(db, {
      idType: "tg",
      uid: "123",
      txHash: "0xabc",
      chainId: "eth",
      token: "usdc",
      amountRaw: "10000000",
      amountUsd: 10,
    });

    expect(p2.id).toBeDefined();
  });

  it("marks payment verified", () => {
    const payment = insertPayment(db, {
      idType: "email",
      uid: "test@example.com",
      txHash: "0xdef456",
      chainId: "eth",
      token: "usdt",
      amountRaw: "0",
      amountUsd: 0,
    });

    markPaymentVerified(db, payment.id, {
      fromAddress: "0xsender",
      toAddress: "0xreceiver",
      amountRaw: "25000000",
      amountUsd: 25,
      blockNumber: 12345678,
      planId: "pro",
    });

    const updated = getPaymentById(db, payment.id)!;
    expect(updated.status).toBe("verified");
    expect(updated.amount_usd).toBe(25);
    expect(updated.plan_id).toBe("pro");
    expect(updated.verified_at).not.toBeNull();
  });

  it("marks payment failed", () => {
    const payment = insertPayment(db, {
      idType: "tg",
      uid: "789",
      txHash: "0xfail",
      chainId: "sol",
      token: "usdc",
      amountRaw: "0",
      amountUsd: 0,
    });

    markPaymentFailed(db, payment.id);

    const updated = getPaymentById(db, payment.id)!;
    expect(updated.status).toBe("failed");
  });

  it("gets payments by user", () => {
    insertPayment(db, { idType: "tg", uid: "42", txHash: "0x1", chainId: "base", token: "usdc", amountRaw: "10000000", amountUsd: 10 });
    insertPayment(db, { idType: "tg", uid: "42", txHash: "0x2", chainId: "eth", token: "usdt", amountRaw: "25000000", amountUsd: 25 });
    insertPayment(db, { idType: "tg", uid: "99", txHash: "0x3", chainId: "base", token: "usdc", amountRaw: "10000000", amountUsd: 10 });

    const user42 = getPaymentsByUser(db, "tg", "42");
    expect(user42).toHaveLength(2);

    const user99 = getPaymentsByUser(db, "tg", "99");
    expect(user99).toHaveLength(1);
  });

  it("gets payment by tx hash", () => {
    insertPayment(db, { idType: "tg", uid: "1", txHash: "0xunique", chainId: "base", token: "usdc", amountRaw: "10000000", amountUsd: 10 });

    const found = getPaymentByTx(db, "0xunique", "base");
    expect(found).not.toBeNull();
    expect(found!.uid).toBe("1");

    const notFound = getPaymentByTx(db, "0xunique", "eth");
    expect(notFound).toBeNull();
  });
});

describe("resolveplan", () => {
  const prices = { starter: 10, pro: 25, max: 100 };

  it("resolves exact amounts", () => {
    expect(resolveplan(10, prices)).toBe("starter");
    expect(resolveplan(25, prices)).toBe("pro");
    expect(resolveplan(100, prices)).toBe("max");
  });

  it("resolves with small variance (within 1%)", () => {
    expect(resolveplan(9.95, prices)).toBe("starter");
    expect(resolveplan(10.05, prices)).toBe("starter");
    expect(resolveplan(24.8, prices)).toBe("pro");
    expect(resolveplan(100.5, prices)).toBe("max");
  });

  it("returns null for unrecognized amounts", () => {
    expect(resolveplan(15, prices)).toBeNull();
    expect(resolveplan(50, prices)).toBeNull();
    expect(resolveplan(0, prices)).toBeNull();
  });
});
