import type { DB } from "../../src/db.js";

// ── Mock Supabase client (in-memory) ─────────────────────────────────────────

export function createMockSupabase(): DB {
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

    const chain: any = {
      select(_cols: string = "*") {
        isSelect = true;
        return chain;
      },
      insert(data: Record<string, unknown>) {
        isInsert = true;
        insertData = {
          id: `uuid-${++idCounter}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...data,
        };
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
            // Unique constraint: payment_intents (tx_hash + chain_id)
            if (tableName === "payment_intents" && insertData.tx_hash) {
              const dup = table.find(
                (r: any) =>
                  r.tx_hash === insertData!.tx_hash &&
                  r.chain_id === insertData!.chain_id,
              );
              if (dup) {
                return resolve({
                  data: null,
                  error: {
                    message:
                      "duplicate key value violates unique constraint",
                  },
                });
              }
            }
            // Unique constraint: customers (id_type + uid)
            if (tableName === "customers" && insertData.id_type) {
              const dup = table.find(
                (r: any) =>
                  r.id_type === insertData!.id_type &&
                  r.uid === insertData!.uid,
              );
              if (dup) {
                return resolve({
                  data: null,
                  error: {
                    message:
                      "duplicate key value violates unique constraint",
                  },
                });
              }
            }
            table.push(insertData);
            stores[tableName] = table;
            result = {
              data: isSelect ? { ...insertData } : null,
              error: null,
            };
          } else if (isUpdate && updateData) {
            let matched = table;
            for (const f of filters) {
              matched = matched.filter((r: any) => r[f.col] === f.val);
            }
            for (const row of matched) {
              Object.assign(row, updateData, {
                updated_at: new Date().toISOString(),
              });
            }
            result = {
              data: isSelect
                ? isSingle
                  ? matched[0] ?? null
                  : matched
                : null,
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
                return ordering!.ascending
                  ? aVal > bVal
                    ? 1
                    : -1
                  : aVal < bVal
                    ? 1
                    : -1;
              });
            }
            matched = matched.slice(rangeStart, rangeEnd + 1);

            if (isSingle) {
              result = {
                data: matched[0] ?? null,
                error:
                  matched.length === 0 ? { code: "PGRST116" } : null,
              };
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
