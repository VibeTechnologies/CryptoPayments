import { describe, it, expect } from "vitest";
import {
  INTENT_PARAM_KEYS,
  INTENT_PARAM_TO_BODY_FIELD,
  buildPaymentBodyFromIntent,
  canonicalIntentString,
} from "../src/intent.ts";

// Every key the signer (OpenClawBot buildCryptoCheckoutUrl / AgentPod) emits.
// If the signer adds a key, add it here AND to INTENT_PARAM_TO_BODY_FIELD.
const SIGNED_URL_KEYS = [
  "plan", "topup", "uid", "idtype", "amountUsd", "exp", "callback",
  "tenantType", "tenant", "vmp", "hostType", "deploymentType",
];

// Values deliberately outside any former client whitelist, with characters
// that would expose encoding/normalisation changes.
function fullIntentParams(): URLSearchParams {
  return new URLSearchParams({
    plan: "max",
    topup: "custom-x",
    uid: "42",
    idtype: "tg",
    amountUsd: "105.00",
    exp: "9999999999",
    callback: "https://cb.example/hook?a=1&b=2",
    tenantType: "Team Ünicode",
    tenant: "Team Ünicode",
    vmp: "lxd",
    hostType: "bare-metal",
    deploymentType: "hermes+beta",
    sig: "deadbeef",
  });
}

/** Canonical string straight from the URL — what the signer HMACs. */
function canonicalFromUrl(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([k]) => k !== "sig")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

describe("checkout intent contract (src/intent.ts)", () => {
  it("INTENT_PARAM_KEYS covers exactly the signer's keys", () => {
    expect([...INTENT_PARAM_KEYS].sort()).toEqual([...SIGNED_URL_KEYS].sort());
    expect(INTENT_PARAM_KEYS).not.toContain("sig");
  });

  it("forwards exactly the intent keys minus sig, values unchanged", () => {
    const params = fullIntentParams();
    const body = buildPaymentBodyFromIntent(params);

    const expected: Record<string, string> = { sig: "deadbeef" };
    for (const key of INTENT_PARAM_KEYS) {
      expected[INTENT_PARAM_TO_BODY_FIELD[key]] = params.get(key)!;
    }
    expect(body).toEqual(expected);
    expect(body.vmProvider).toBe("lxd");
  });

  it("round-trips: canonical(body) === canonical(signed URL)", () => {
    const params = fullIntentParams();
    const body = buildPaymentBodyFromIntent(params);
    expect(canonicalIntentString(body)).toBe(canonicalFromUrl(params));
  });

  it.each(SIGNED_URL_KEYS.filter((k) => !["uid", "exp", "idtype", "tenant"].includes(k)))(
    "round-trips when only %s is present among optional keys",
    (key) => {
      const params = new URLSearchParams({ uid: "7", idtype: "tg", exp: "9999999999" });
      params.set(key, "odd-value-lxd");
      if (key === "tenantType") params.set("tenant", "odd-value-lxd");
      expect(canonicalIntentString(buildPaymentBodyFromIntent(params))).toBe(canonicalFromUrl(params));
    },
  );

  it("accepts the legacy vmProvider alias", () => {
    const body = buildPaymentBodyFromIntent(new URLSearchParams({ uid: "1", vmProvider: "lxd" }));
    expect(body.vmProvider).toBe("lxd");
  });

  it("omits absent params", () => {
    expect(buildPaymentBodyFromIntent(new URLSearchParams({ uid: "1" }))).toEqual({ uid: "1" });
  });
});
