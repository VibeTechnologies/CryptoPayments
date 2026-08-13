const baseUrl = (process.env.CRYPTO_PAYMENTS_API_URL ?? "").replace(/\/$/, "");
const apiKey = process.env.API_KEY ?? "";
const maxAgeMinutes = Number(process.env.RECONCILE_MIN_AGE_MINUTES ?? "10");

if (!baseUrl || !apiKey) {
  console.error("[reconcile-payments] CRYPTO_PAYMENTS_API_URL and API_KEY are required");
  process.exit(2);
}

type Intent = {
  id: string;
  status: string;
  created_at: string;
  metadata?: { callback_state?: { status?: string } };
};

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "x-api-key": apiKey, "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const candidates = new Map<string, Intent>();
for (const status of ["processing", "requires_payment_method", "succeeded"]) {
  for (let offset = 0; ; offset += 100) {
    const { response, body } = await request(`/v1/payment_intents?status=${status}&limit=100&offset=${offset}`);
    if (!response.ok) {
      console.error(`[reconcile-payments] list ${status} failed: HTTP ${response.status}`);
      process.exit(2);
    }
    const intents = (body.data ?? []) as Intent[];
    for (const intent of intents) {
      const stale = Date.now() - Date.parse(intent.created_at) >= maxAgeMinutes * 60_000;
      const callbackStatus = intent.metadata?.callback_state?.status;
      if (stale && (status !== "succeeded" || callbackStatus !== "delivered")) {
        candidates.set(intent.id, intent);
      }
    }
    if (intents.length < 100) break;
  }
}

let resolved = 0;
const unresolved: Array<{ id: string; http: number; error: string }> = [];
for (const intent of candidates.values()) {
  const { response, body } = await request(`/v1/payment_intents/${encodeURIComponent(intent.id)}/reconcile`, {
    method: "POST",
  });
  if (response.ok) resolved += 1;
  else unresolved.push({ id: intent.id, http: response.status, error: String(body.error ?? "unknown") });
}

console.log(JSON.stringify({ checked: candidates.size, resolved, unresolved }, null, 2));
if (unresolved.length) process.exit(1);
