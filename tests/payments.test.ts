import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveplan } from "../src/verify.js";
import type { DB, PaymentRecord, CustomerRecord, PaymentIntentRecord } from "../src/db.js";

// ── Mock Supabase client ─────────────────────────────────────────────────────
// Since DB functions now hit Supabase, we mock the supabase-js client and
// test the legacy compatibility layer logic in isolation.

function createMockSupabase(): DB {
  // In-memory stores
  const stores: Record<string, Record<string, unknown>[]> = {
    customers: [],
    payment_intents: [],
    invoices: [],
    invoice_line_items: [],
    checkout_sessions: [],
    webhook_events: [],
  };

  let idCounter = 0;

  function makeChain(tableName: string) {
    let query: Record<string, unknown> = {};
    let table = stores[tableName] ?? [];
    let filters: Array<{ col: string; val: unknown }> = [];
    let isSingle = false;
    let isInsert = false;
    let isUpdate = false;
    let isSelect = false;
    let insertData: Record<string, unknown> | null = null;
    let updateData: Record<string, unknown> | null = null;
    let ordering: { col: string; ascending: boolean } | null = null;
    let rangeStart = 0;
    let rangeEnd = Infinity;
    let selectCols = "*";
    let nestedSelect: string | null = null;

    const chain: any = {
      select(cols: string = "*") {
        isSelect = true;
        selectCols = cols;
        // Check for nested selects like "*, invoice_line_items(*)"
        if (cols.includes("(")) {
          nestedSelect = cols;
        }
        return chain;
      },
      insert(data: Record<string, unknown>) {
        isInsert = true;
        insertData = { id: `uuid-${++idCounter}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...data };
        return chain;
      },
      update(data: Record<string, unknown>) {
        isUpdate = true;
        updateData = data;
        return chain;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, val });
        return chain;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        ordering = { col, ascending: opts?.ascending ?? true };
        return chain;
      },
      range(start: number, end: number) {
        rangeStart = start;
        rangeEnd = end;
        return chain;
      },
      single() {
        isSingle = true;
        return chain;
      },
      then(resolve: (val: any) => void, reject?: (err: any) => void) {
        try {
          let result: any;

          if (isInsert && insertData) {
            // Check unique constraints for payment_intents (tx_hash + chain_id)
            if (tableName === "payment_intents" && insertData.tx_hash) {
              const dup = table.find(
                (r: any) => r.tx_hash === insertData!.tx_hash && r.chain_id === insertData!.chain_id,
              );
              if (dup) {
                return resolve({ data: null, error: { message: "duplicate key value violates unique constraint" } });
              }
            }
            // Check unique constraints for customers (id_type + uid)
            if (tableName === "customers" && insertData.id_type) {
              const dup = table.find(
                (r: any) => r.id_type === insertData!.id_type && r.uid === insertData!.uid,
              );
              if (dup) {
                return resolve({ data: null, error: { message: "duplicate key value violates unique constraint" } });
              }
            }
            table.push(insertData);
            stores[tableName] = table;
            result = { data: isSelect ? { ...insertData } : null, error: null };
            if (isSingle && result.data) result.data = result.data;
          } else if (isUpdate && updateData) {
            let matched = table;
            for (const f of filters) {
              matched = matched.filter((r: any) => r[f.col] === f.val);
            }
            for (const row of matched) {
              Object.assign(row, updateData, { updated_at: new Date().toISOString() });
            }
            result = {
              data: isSelect ? (isSingle ? matched[0] ?? null : matched) : null,
              error: null,
            };
          } else {
            // Select query
            let matched = table;
            for (const f of filters) {
              matched = matched.filter((r: any) => r[f.col] === f.val);
            }
            if (ordering) {
              matched.sort((a: any, b: any) => {
                const aVal = a[ordering!.col];
                const bVal = b[ordering!.col];
                return ordering!.ascending ? (aVal > bVal ? 1 : -1) : (aVal < bVal ? 1 : -1);
              });
            }
            matched = matched.slice(rangeStart, rangeEnd + 1);

            if (isSingle) {
              result = { data: matched[0] ?? null, error: matched.length === 0 ? { code: "PGRST116" } : null };
            } else {
              result = { data: matched, error: null };
            }
          }

          resolve(result);
        } catch (err) {
          if (reject) reject(err);
          else resolve({ data: null, error: { message: String(err) } });
        }
      },
    };

    return chain;
  }

  return {
    from(tableName: string) {
      return makeChain(tableName);
    },
  } as unknown as DB;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Database (mocked Supabase)", () => {
  let db: DB;
  let mod: typeof import("../src/db.js");

  beforeEach(async () => {
    db = createMockSupabase();
    mod = await import("../src/db.js");
  });

  it("inserts and retrieves a payment", async () => {
    const payment = await mod.insertPayment(db, {
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

    const fetched = await mod.getPaymentById(db, payment.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.tx_hash).toBe("0xabc123");
  });

  it("marks payment verified", async () => {
    const payment = await mod.insertPayment(db, {
      idType: "email",
      uid: "test@example.com",
      txHash: "0xdef456",
      chainId: "eth",
      token: "usdt",
      amountRaw: "0",
      amountUsd: 0,
    });

    await mod.markPaymentVerified(db, payment.id, {
      fromAddress: "0xsender",
      toAddress: "0xreceiver",
      amountRaw: "25000000",
      amountUsd: 25,
      blockNumber: 12345678,
      planId: "pro",
    });

    const updated = await mod.getPaymentById(db, payment.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("verified");
    expect(updated!.plan_id).toBe("pro");
    expect(updated!.verified_at).not.toBeNull();
  });

  it("marks payment failed", async () => {
    const payment = await mod.insertPayment(db, {
      idType: "tg",
      uid: "789",
      txHash: "0xfail",
      chainId: "sol",
      token: "usdc",
      amountRaw: "0",
      amountUsd: 0,
    });

    await mod.markPaymentFailed(db, payment.id);

    const updated = await mod.getPaymentById(db, payment.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("failed");
  });

  it("gets payments by user", async () => {
    await mod.insertPayment(db, { idType: "tg", uid: "42", txHash: "0x1", chainId: "base", token: "usdc", amountRaw: "10000000", amountUsd: 10 });
    await mod.insertPayment(db, { idType: "tg", uid: "42", txHash: "0x2", chainId: "eth", token: "usdt", amountRaw: "25000000", amountUsd: 25 });
    await mod.insertPayment(db, { idType: "tg", uid: "99", txHash: "0x3", chainId: "base", token: "usdc", amountRaw: "10000000", amountUsd: 10 });

    const user42 = await mod.getPaymentsByUser(db, "tg", "42");
    expect(user42).toHaveLength(2);

    const user99 = await mod.getPaymentsByUser(db, "tg", "99");
    expect(user99).toHaveLength(1);
  });

  it("gets payment by tx hash", async () => {
    await mod.insertPayment(db, { idType: "tg", uid: "1", txHash: "0xunique", chainId: "base", token: "usdc", amountRaw: "10000000", amountUsd: 10 });

    const found = await mod.getPaymentByTx(db, "0xunique", "base");
    expect(found).not.toBeNull();
    expect(found!.uid).toBe("1");

    const notFound = await mod.getPaymentByTx(db, "0xunique", "eth");
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
