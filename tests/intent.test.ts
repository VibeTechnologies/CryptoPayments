import { describe, it, expect } from "vitest";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type IntentBody,
  findInvalidSignedIntentParams,
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

  it("forwards a present-but-empty signed key as \"\" (page must reject it before transfer)", () => {
    const params = new URLSearchParams({ uid: "7", idtype: "tg", exp: "9999999999", plan: "starter", vmp: "" });
    expect(buildPaymentBodyFromIntent(params)).toHaveProperty("vmProvider", "");
    // Such a URL can never verify (canonical(body) omits empty optionals while
    // the raw URL entry is `vmp=`), so it must be flagged up front.
    expect(canonicalIntentString(buildPaymentBodyFromIntent(params))).not.toBe(canonicalFromUrl(params));
    expect(findInvalidSignedIntentParams(params)).toContain("vmp");
  });
});

// Independent model of AgentPod's signer (canonicalIntent): every URL entry
// except sig, sorted by key with localeCompare, `key=value`, joined by "\n",
// HMAC-SHA256 hex. The verifier side mirrors src/server.ts verifyCheckoutIntent.
const SECRET = "test-checkout-secret";

function agentPodSign(params: URLSearchParams): string {
  const canonical = [...params.entries()]
    .filter(([k]) => k !== "sig")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  return createHmac("sha256", SECRET).update(canonical).digest("hex");
}

function serverVerifies(body: IntentBody): boolean {
  if (!body.exp || !body.sig) return false;
  if (body.idType !== undefined && body.idType !== "tg") return false;
  const expected = Buffer.from(createHmac("sha256", SECRET).update(canonicalIntentString(body)).digest("hex"));
  const actual = Buffer.from(body.sig);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

describe("AgentPod signer model -> pay page body -> server verification", () => {
  function agentPodUrl(): URLSearchParams {
    const params = new URLSearchParams();
    params.set("plan", "max");
    params.set("uid", "42");
    params.set("idtype", "tg");
    params.set("amountUsd", "105.00");
    params.set("exp", "9999999999");
    params.set("tenantType", "team");
    params.set("tenant", "team");
    params.set("vmp", "lxd");
    params.set("hostType", "vps");
    params.set("deploymentType", "hermes");
    params.set("sig", agentPodSign(params));
    return params;
  }

  it("a URL signed like AgentPod verifies after buildPaymentBodyFromIntent", () => {
    const params = agentPodUrl();
    expect(findInvalidSignedIntentParams(params)).toEqual([]);
    const body = buildPaymentBodyFromIntent(params);
    expect(body.vmProvider).toBe("lxd");
    expect(body.idType).toBe("tg");
    expect(serverVerifies(body)).toBe(true);
  });

  it("tampering with a signed value fails verification", () => {
    const params = agentPodUrl();
    params.set("vmp", "azure");
    expect(serverVerifies(buildPaymentBodyFromIntent(params))).toBe(false);
  });
});

describe("findInvalidSignedIntentParams", () => {
  const base = { uid: "7", idtype: "tg", exp: "9999999999", plan: "starter", sig: "abc" };

  it("returns [] for a well-formed signed link", () => {
    expect(findInvalidSignedIntentParams(new URLSearchParams(base))).toEqual([]);
  });

  it("reports vmp= (present but empty)", () => {
    expect(findInvalidSignedIntentParams(new URLSearchParams({ ...base, vmp: "" }))).toEqual(["vmp"]);
  });

  it("reports the empty legacy vmProvider alias", () => {
    expect(findInvalidSignedIntentParams(new URLSearchParams({ ...base, vmProvider: "" }))).toEqual(["vmProvider"]);
  });

  it("reports idtype=email when sig is present", () => {
    expect(findInvalidSignedIntentParams(new URLSearchParams({ ...base, idtype: "email" }))).toEqual(["idtype"]);
  });

  it("reports a missing idtype when sig is present", () => {
    const { idtype: _omit, ...rest } = base;
    expect(findInvalidSignedIntentParams(new URLSearchParams(rest))).toEqual(["idtype"]);
  });

  it("does not flag idtype=email on an unsigned link", () => {
    const { sig: _omit, ...rest } = base;
    expect(findInvalidSignedIntentParams(new URLSearchParams({ ...rest, idtype: "email" }))).toEqual([]);
  });
});
