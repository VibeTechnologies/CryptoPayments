#!/usr/bin/env -S npx tsx
/**
 * Cross-service credit assertion for the live aUSD top-up E2E.
 *
 * Drives OpenClawBot's REAL crypto-webhook handler (createCryptoWebhookHandler)
 * with the ACTUAL callback payload + X-Signature that CryptoPayments emitted
 * during the live Sepolia run. Uses a real in-memory pglite DB (createTestDB)
 * plus a spy LiteLLM client, and asserts the user is credited the small pack's
 * USD value (plan budget + CREDIT_PACKS.small.budgetIncrease).
 *
 * It is NOT a mock of the bot path: the same HMAC the payments service signed is
 * verified by the bot's real verifyCryptoSignature, and the real
 * processTopUpPayment logic computes the new budget. Only db + litellm + bot are
 * injected (the handler's deps), exactly as in tests/unit/crypto-webhook.test.ts.
 *
 * Env:
 *   OCB_REPO         absolute path to the OpenClawBot repo
 *   CB_PAYLOAD_FILE  json file written by the callback receiver:
 *                    { rawBody, signature, timestamp, sigValid, payload }
 *   CALLBACK_SECRET  HMAC secret CryptoPayments signed with (default testsecret)
 *   TEST_UID         telegram uid carried in the payload (seed user matches)
 *
 * Prints "OCB CREDIT PASS: ..." and exits 0 on success; prints "FAIL: ..." and
 * exits 1 otherwise.
 */
import { readFileSync } from "node:fs";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const OCB = process.env.OCB_REPO;
const CB_FILE = process.env.CB_PAYLOAD_FILE;
const SECRET = process.env.CALLBACK_SECRET ?? "testsecret";
const UID = process.env.TEST_UID ?? "77777";

if (!OCB) fail("OCB_REPO env is required");
if (!CB_FILE) fail("CB_PAYLOAD_FILE env is required");

const cb = JSON.parse(readFileSync(CB_FILE!, "utf8"));
const rawBody: string = cb.rawBody;
const signature: string = cb.signature;
const timestamp: string = cb.timestamp;
if (typeof rawBody !== "string" || !signature) {
  fail(`callback file malformed: ${JSON.stringify(cb).slice(0, 300)}`);
}

// Real OpenClawBot modules (tsx resolves .ts via absolute path).
const { createCryptoWebhookHandler } = await import(`${OCB}/src/payments/crypto-webhook.ts`);
const { createTestDB } = await import(`${OCB}/tests/helpers/test-db.ts`);
const { upsertUser } = await import(`${OCB}/src/db/users.ts`);
const { createSubscription } = await import(`${OCB}/src/db/subscriptions.ts`);
const { createTenant } = await import(`${OCB}/src/db/tenants.ts`);
const { getPaymentByCryptoTxHash } = await import(`${OCB}/src/db/payments.ts`);
const { PLANS, CREDIT_PACKS } = await import(`${OCB}/src/config.ts`);

// Expected credit derived from the bot's own source of truth (no hardcode).
const PLAN_ID = "pro";
const planBudget: number = PLANS[PLAN_ID].litellmBudget;
const packIncrease: number = CREDIT_PACKS.small.budgetIncrease;
const expectedMaxBudget = planBudget + packIncrease;

const { db } = await createTestDB();

// Seed the test user with an ACTIVE pro subscription (litellmBudget > 0) — the
// precondition processTopUpPayment requires before it credits.
const user = await upsertUser(db, { telegramId: Number(UID) });
const subscription = await createSubscription(db, {
  userId: user.id,
  planId: PLAN_ID,
  startsAt: new Date(),
  expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
});
await createTenant(db, {
  userId: user.id,
  subscriptionId: subscription.id,
  subdomain: "oc-topup-live",
  namespace: "tenant-oc-topup-live",
  gatewayToken: "token",
  resourceProfile: "pro",
});

// Spy LiteLLM client + minimal bot.
const calls: Array<[string, any]> = [];
const litellm = {
  updateUser: async (a: any) => {
    calls.push(["updateUser", a]);
  },
  updateKey: async (a: any) => {
    calls.push(["updateKey", a]);
  },
} as any;
const bot = { api: { sendMessage: async () => undefined } } as any;

const handler = createCryptoWebhookHandler({
  bot,
  db,
  provisioner: null,
  litellm,
  callbackSecret: SECRET,
});

// Mock IncomingMessage that streams the exact raw body (mirrors the unit test).
function makeReq(body: string, sig: string, ts: string): any {
  const chunks = [Buffer.from(body)];
  let dataCb: ((c: Buffer) => void) | null = null;
  let endCb: (() => void) | null = null;
  const req: any = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature": sig,
      "x-timestamp": ts,
    },
    socket: { remoteAddress: "10.0.0.7" },
    destroy: () => {},
    on(ev: string, cb: any) {
      if (ev === "data") dataCb = cb;
      if (ev === "end") endCb = cb;
      if (dataCb && endCb) {
        process.nextTick(() => {
          for (const c of chunks) dataCb!(c);
          endCb!();
        });
      }
      return req;
    },
  };
  return req;
}
function makeRes(): any {
  const res: any = {
    statusCode: 200,
    body: "",
    writeHead(code: number) {
      res.statusCode = code;
      return res;
    },
    end(b?: string) {
      res.body = b ?? "";
    },
  };
  return res;
}

const req = makeReq(rawBody, signature, timestamp);
const res = makeRes();
await handler(req, res);

if (res.statusCode !== 200) {
  fail(`webhook rejected the live callback: status=${res.statusCode} body=${res.body}`);
}

// Handler answers 200 then processes fire-and-forget; poll for the credit call.
const deadline = Date.now() + 15000;
while (Date.now() < deadline && !calls.find((c) => c[0] === "updateUser")) {
  await new Promise((r) => setTimeout(r, 200));
}

const uu = calls.find((c) => c[0] === "updateUser");
if (!uu) {
  const txHash = JSON.parse(rawBody)?.payment?.txHash;
  let payRow: any = null;
  try {
    payRow = await getPaymentByCryptoTxHash(db, txHash);
  } catch {
    /* ignore */
  }
  fail(
    `litellm.updateUser was never called — user NOT credited. ` +
      `calls=${JSON.stringify(calls)} paymentRow=${JSON.stringify(payRow)}`,
  );
}

const arg = uu[1];
if (typeof arg?.maxBudget !== "number") {
  fail(`updateUser called without numeric maxBudget: ${JSON.stringify(arg)}`);
}
if (arg.maxBudget !== expectedMaxBudget) {
  fail(
    `credited maxBudget=${arg.maxBudget}, expected ${expectedMaxBudget} ` +
      `(plan ${PLAN_ID} budget ${planBudget} + small pack +${packIncrease})`,
  );
}

console.log(
  `OCB CREDIT PASS: litellm.updateUser({ userId: ${arg.userId}, maxBudget: ${arg.maxBudget} }) — ` +
    `small pack credited +$${packIncrease} (${planBudget} -> ${expectedMaxBudget}); ` +
    `live callback signature verified by bot handler.`,
);
process.exit(0);
