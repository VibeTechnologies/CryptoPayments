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
 * Values are forwarded byte-for-byte; absent keys are omitted. `sig` is
 * forwarded unchanged when present.
 *
 * Contract: the signer HMACs every present URL entry (except `sig`) and never
 * emits a signed key with an empty value. A present-but-empty signed key
 * (e.g. `vmp=`) is forwarded as "" here, but the server canonicalisation
 * omits empty optionals, so such a URL cannot verify. Callers MUST reject it
 * with findInvalidSignedIntentParams BEFORE any on-chain transfer.
 */
export function buildPaymentBodyFromIntent(params: URLSearchParams): IntentBody {
  const body: IntentBody = {};
  for (const key of INTENT_PARAM_KEYS) {
    const value = params.get(key);
    if (value === null) continue;
    const field = INTENT_PARAM_TO_BODY_FIELD[key];
    // tenantType wins over its `tenant` mirror if both are non-empty.
    if (body[field]) continue;
    body[field] = value;
  }
  for (const [alias, key] of Object.entries(INTENT_PARAM_ALIASES)) {
    const field = INTENT_PARAM_TO_BODY_FIELD[key];
    const value = params.get(alias);
    if (value !== null && body[field] === undefined) body[field] = value;
  }
  const sig = params.get("sig");
  if (sig) body.sig = sig;
  return body;
}

/**
 * Signed URL keys that make a signed link unusable, checked BEFORE any
 * on-chain transfer. Returns:
 *   - every signed key (INTENT_PARAM_KEYS plus aliases) present with an empty
 *     value. The signer never emits these and the server would compute a
 *     different canonical string (it omits empty optionals), so the payment
 *     would 401 after the money moved;
 *   - "idtype" when `sig` is present and idtype is not exactly "tg" (signed
 *     intents are Telegram-only; the server rejects anything else).
 * Empty result means the link is structurally valid (the HMAC itself is
 * checked server-side).
 */
export function findInvalidSignedIntentParams(params: URLSearchParams): string[] {
  const invalid: string[] = [];
  const signedKeys: string[] = [...INTENT_PARAM_KEYS, ...Object.keys(INTENT_PARAM_ALIASES)];
  for (const key of signedKeys) {
    if (params.has(key) && params.getAll(key).some((v) => v === "")) invalid.push(key);
  }
  if (params.has("sig") && params.get("idtype") !== "tg" && !invalid.includes("idtype")) {
    invalid.push("idtype");
  }
  return invalid;
}

/**
 * Canonical string the HMAC is computed over, rebuilt from an /api/payment
 * body. Sorted `key=value` lines joined by "\n". `idtype` is always "tg"
 * (signed intents are Telegram-only); `uid` and `exp` are always present.
 *
 * Empty optional values are OMITTED. The signer signs every present URL entry
 * and never emits an empty signed key, so for every legitimately signed URL
 * this equals the signer's canonical string. A URL carrying `key=` (empty)
 * therefore does NOT verify; the pay page rejects such links up front via
 * findInvalidSignedIntentParams instead of after the transfer.
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
