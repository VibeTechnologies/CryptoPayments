// Checkout-intent wire contract — the SINGLE source of truth shared by:
//   - the server verifier (src/server.ts verifyCheckoutIntent), which rebuilds
//     the canonical string from the /api/payment body and checks the HMAC, and
//   - the pay page (web/src/app/pay/page.tsx), which must forward every signed
//     intent param from its URL to /api/payment VERBATIM.
//
// Why this exists: the pay page used to whitelist signed values per field
// (e.g. vmp ∈ {azure, hetzner}). When AgentPod signed vmp=lxd the page dropped
// it, the recomputed canonical string no longer matched, and /api/payment
// 401'd AFTER the customer's on-chain transfer was mined. Signed values must
// never be validated, normalised, or defaulted on the client — the signature
// is the validation. Adding a signed key here updates both sides at once.
//
// Keep this module dependency-free (no node:*, no env) so the browser bundle
// can import it.

/** URL query key -> /api/payment body field, for every signed intent param. */
export const INTENT_PARAM_TO_BODY_FIELD = {
  plan: "plan",
  topup: "topup",
  uid: "uid",
  idtype: "idType",
  amountUsd: "amountUsd",
  exp: "exp",
  callback: "callbackUrl",
  tenantType: "tenantType",
  tenant: "tenantType", // signer emits both tenantType and tenant (same value)
  vmp: "vmProvider",
  hostType: "hostType",
  deploymentType: "deploymentType",
} as const;

export type IntentParamKey = keyof typeof INTENT_PARAM_TO_BODY_FIELD;
export type IntentBodyField = (typeof INTENT_PARAM_TO_BODY_FIELD)[IntentParamKey];

/** Every URL query key covered by the checkout-intent HMAC (excludes `sig`). */
export const INTENT_PARAM_KEYS = Object.keys(INTENT_PARAM_TO_BODY_FIELD) as IntentParamKey[];

/** Legacy URL aliases accepted by the pay page (alias -> canonical URL key). */
export const INTENT_PARAM_ALIASES: Readonly<Record<string, IntentParamKey>> = {
  vmProvider: "vmp",
};

export type IntentBody = Partial<Record<IntentBodyField | "sig", string>>;

/**
 * Map URL query params to the /api/payment body fields for the signed intent.
 * Values are forwarded byte-for-byte; absent or empty params are omitted.
 * `sig` is forwarded unchanged when present.
 */
export function buildPaymentBodyFromIntent(params: URLSearchParams): IntentBody {
  const body: IntentBody = {};
  for (const key of INTENT_PARAM_KEYS) {
    const value = params.get(key);
    if (!value) continue;
    const field = INTENT_PARAM_TO_BODY_FIELD[key];
    // tenantType wins over its `tenant` mirror if both are present.
    if (body[field] !== undefined) continue;
    body[field] = value;
  }
  for (const [alias, key] of Object.entries(INTENT_PARAM_ALIASES)) {
    const field = INTENT_PARAM_TO_BODY_FIELD[key];
    const value = params.get(alias);
    if (value && body[field] === undefined) body[field] = value;
  }
  const sig = params.get("sig");
  if (sig) body.sig = sig;
  return body;
}

/**
 * Canonical string the HMAC is computed over, rebuilt from an /api/payment
 * body. Sorted `key=value` lines joined by "\n". `idtype` is always "tg"
 * (signed intents are Telegram-only); `uid` and `exp` are always present.
 */
export function canonicalIntentString(body: Partial<Record<IntentBodyField, string | undefined>>): string {
  const entries: [string, string][] = [];
  for (const key of INTENT_PARAM_KEYS) {
    let value: string | undefined;
    if (key === "idtype") value = "tg";
    else value = body[INTENT_PARAM_TO_BODY_FIELD[key]];
    if (key === "uid" || key === "exp") {
      entries.push([key, value ?? ""]);
    } else if (value) {
      entries.push([key, value]);
    }
  }
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}
