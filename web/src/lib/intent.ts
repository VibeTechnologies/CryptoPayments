// Re-export of the single-source checkout-intent contract (repo-root src/intent.ts),
// shared with the server verifier. Do NOT copy or fork it here.
export {
  INTENT_PARAM_KEYS,
  INTENT_PARAM_TO_BODY_FIELD,
  INTENT_PARAM_ALIASES,
  buildPaymentBodyFromIntent,
  canonicalIntentString,
  type IntentBody,
  type IntentParamKey,
} from "../../../src/intent";
