import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = undefined;
});

async function runReconciler(handler: Parameters<typeof createServer>[0]) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");

  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/reconcile-payments.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CRYPTO_PAYMENTS_API_URL: `http://127.0.0.1:${address.port}`,
        API_KEY: "test-key",
        RECONCILE_MIN_AGE_MINUTES: "10",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("scheduled payment reconciler", () => {
  it("reconciles a stale provider intent through the real HTTP API", async () => {
    const requests: string[] = [];
    const result = await runReconciler((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("status=processing")) {
        res.end(JSON.stringify({ data: [{ id: "pi_stale", customer_id: "cus_1", tx_hash: "0xstale", status: "processing", created_at: "2020-01-01T00:00:00Z" }] }));
      } else if (req.method === "POST" && req.url === "/v1/payment_intents/pi_stale/reconcile") {
        res.end(JSON.stringify({ ok: true, action: "verified_and_delivered" }));
      } else {
        res.end(JSON.stringify({ data: [] }));
      }
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ checked: 1, resolved: 1, unresolved: [] });
    expect(requests).toContain("POST /v1/payment_intents/pi_stale/reconcile");
  });

  it("exits nonzero when provider state cannot be reconciled", async () => {
    const result = await runReconciler((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("status=succeeded")) {
        res.end(JSON.stringify({ data: [{
          id: "pi_undelivered",
          customer_id: "cus_2",
          tx_hash: "0xundelivered",
          status: "succeeded",
          created_at: "2020-01-01T00:00:00Z",
          metadata: { callback_state: { status: "failed" } },
        }] }));
      } else if (req.method === "POST") {
        res.statusCode = 502;
        res.end(JSON.stringify({ error: "callback unavailable" }));
      } else {
        res.end(JSON.stringify({ data: [] }));
      }
    });

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      checked: 1,
      resolved: 0,
      unresolved: [{ id: "pi_undelivered", http: 502, error: "callback unavailable" }],
    });
  });
});
