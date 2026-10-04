import { describe, it, expect } from "vitest";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type IntentBody,
  findInvalidSignedIntentParams,
  UNSIGNED_UI_KEYS,
  isUnexpiredExp,
  INTENT_PARAM_KEYS,
  INTENT_PARAM_TO_BODY_FIELD,
  buildPaymentBodyFromIntent,
  canonicalIntentString,
  rawIntentCanonicalString,
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

describe("findInvalidSignedIntentParams: pre-send sig/exp guard", () => {
  const NOW = 1_700_000_000;
  const base = { uid: "7", idtype: "tg", exp: String(NOW + 600), plan: "starter", sig: "abc" };

  it("reports sig present but empty", () => {
    expect(findInvalidSignedIntentParams(new URLSearchParams({ ...base, sig: "" }), NOW)).toContain("sig");
  });

  it("reports missing exp on a signed link", () => {
    const { exp: _omit, ...rest } = base;
    expect(findInvalidSignedIntentParams(new URLSearchParams(rest), NOW)).toContain("exp");
  });

  it.each(["abc", "12.5", "1e10", "-5", " 1700000600"])("reports non-integer exp %j", (exp) => {
    expect(findInvalidSignedIntentParams(new URLSearchParams({ ...base, exp }), NOW)).toContain("exp");
  });

  it("reports exp <= now (boundary and past)", () => {
    expect(findInvalidSignedIntentParams(new URLSearchParams({ ...base, exp: String(NOW) }), NOW)).toEqual(["exp"]);
    expect(findInvalidSignedIntentParams(new URLSearchParams({ ...base, exp: String(NOW - 1) }), NOW)).toEqual(["exp"]);
  });

  it("reports a non-finite / unsafe-integer exp (310 nines) as invalid exp", () => {
    const exp = "9".repeat(310); // all digits, but Number(exp) === Infinity
    expect(findInvalidSignedIntentParams(new URLSearchParams({ ...base, exp }), NOW)).toEqual(["exp"]);
    expect(isUnexpiredExp(exp, NOW)).toBe(false);
    // Smallest digits-only value past Number.MAX_SAFE_INTEGER is rejected too.
    expect(isUnexpiredExp("9007199254740992", NOW)).toBe(false);
    expect(isUnexpiredExp(String(Number.MAX_SAFE_INTEGER), NOW)).toBe(true);
  });

  it("accepts exp in the future", () => {
    expect(findInvalidSignedIntentParams(new URLSearchParams({ ...base, exp: String(NOW + 1) }), NOW)).toEqual([]);
  });

  it("defaults nowSec to the current time", () => {
    const past = String(Math.floor(Date.now() / 1000) - 1);
    expect(findInvalidSignedIntentParams(new URLSearchParams({ ...base, exp: past }))).toEqual(["exp"]);
  });

  it("does not check exp on an unsigned link", () => {
    const { sig: _s, exp: _e, ...rest } = base;
    expect(findInvalidSignedIntentParams(new URLSearchParams(rest), NOW)).toEqual([]);
  });
});

describe("findInvalidSignedIntentParams: settleable + closed signed links (#58 r6)", () => {
  const NOW = 1_700_000_000;
  const base = { uid: "7", idtype: "tg", exp: String(NOW + 600), plan: "starter", sig: "abc" };

  it("reports a signed link with neither plan nor topup", () => {
    const { plan: _p, ...rest } = base;
    expect(findInvalidSignedIntentParams(new URLSearchParams({ ...rest, amountUsd: "42.00" }), NOW)).toEqual(["plan"]);
  });

  it("accepts a topup-only signed link", () => {
    const { plan: _p, ...rest } = base;
    expect(findInvalidSignedIntentParams(new URLSearchParams({ ...rest, topup: "small" }), NOW)).toEqual([]);
  });

  it("does not require plan/topup on an unsigned link", () => {
    const { plan: _p, sig: _s, ...rest } = base;
    expect(findInvalidSignedIntentParams(new URLSearchParams(rest), NOW)).toEqual([]);
  });

  it("reports unknown keys on a signed link (fail closed)", () => {
    const params = new URLSearchParams({
      uid: "42", idtype: "tg", exp: String(NOW + 600), plan: "max", vmp: "lxd",
      hostType: "vps", deploymentType: "hermes", nonce: "123", sig: "x",
    });
    expect(findInvalidSignedIntentParams(params, NOW)).toEqual(["nonce"]);
  });

  it("allows only the minimal UI allowlist (test) as unsigned keys", () => {
    expect(UNSIGNED_UI_KEYS).toEqual(["test"]);
    expect(findInvalidSignedIntentParams(new URLSearchParams({ ...base, test: "true" }), NOW)).toEqual([]);
    for (const key of ["token", "chain", "apiKey", "initData", "utm_source"]) {
      expect(findInvalidSignedIntentParams(new URLSearchParams({ ...base, [key]: "v" }), NOW), key).toEqual([key]);
    }
  });

  it("ignores unknown keys on an unsigned link", () => {
    const { sig: _s, ...rest } = base;
    expect(findInvalidSignedIntentParams(new URLSearchParams({ ...rest, nonce: "1" }), NOW)).toEqual([]);
  });
});

describe("findInvalidSignedIntentParams: non-round-trippable signed URL shapes", () => {
  const NOW = 1_700_000_000;
  function agentPodLxd(): URLSearchParams {
    const p = new URLSearchParams();
    p.set("plan", "max");
    p.set("uid", "42");
    p.set("idtype", "tg");
    p.set("exp", String(NOW + 3600));
    p.set("tenantType", "team");
    p.set("tenant", "team");
    p.set("vmp", "lxd");
    p.set("hostType", "vps");
    p.set("deploymentType", "hermes");
    p.set("callback", "https://agentpod.example/cb?x=1");
    p.set("sig", "deadbeef");
    return p;
  }

  it("normal AgentPod LXD shape is valid and raw canonical == body canonical", () => {
    const params = agentPodLxd();
    expect(findInvalidSignedIntentParams(params, NOW)).toEqual([]);
    expect(rawIntentCanonicalString(params)).toBe(canonicalIntentString(buildPaymentBodyFromIntent(params)));
    expect(rawIntentCanonicalString(params)).toBe(canonicalFromUrl(params));
  });

  it.each([...SIGNED_URL_KEYS, "vmProvider"])("rejects duplicated signed key %s", (key) => {
    const params = agentPodLxd();
    const value = params.get(key) ?? "dup";
    params.append(key, value);
    if (params.getAll(key).length < 2) params.append(key, value);
    expect(findInvalidSignedIntentParams(params, NOW)).toContain(key);
  });

  it("rejects duplicated sig", () => {
    const params = agentPodLxd();
    params.append("sig", "deadbeef");
    expect(findInvalidSignedIntentParams(params, NOW)).toContain("sig");
  });

  it("rejects tenant without tenantType", () => {
    const params = agentPodLxd();
    params.delete("tenantType");
    expect(findInvalidSignedIntentParams(params, NOW)).toContain("tenant");
    expect(rawIntentCanonicalString(params)).not.toBe(canonicalIntentString(buildPaymentBodyFromIntent(params)));
  });

  it("rejects tenant and tenantType with different values", () => {
    const params = agentPodLxd();
    params.set("tenant", "personal");
    expect(findInvalidSignedIntentParams(params, NOW)).toContain("tenant");
    expect(rawIntentCanonicalString(params)).not.toBe(canonicalIntentString(buildPaymentBodyFromIntent(params)));
  });

  it("generic check rejects tenantType without its tenant mirror (body canonical emits both)", () => {
    const params = agentPodLxd();
    params.delete("tenant");
    expect(rawIntentCanonicalString(params)).not.toBe(canonicalIntentString(buildPaymentBodyFromIntent(params)));
    expect(findInvalidSignedIntentParams(params, NOW)).toEqual(["canonical"]);
  });

  it("rejects the legacy vmProvider alias on a signed URL", () => {
    const params = agentPodLxd();
    params.delete("vmp");
    params.set("vmProvider", "lxd");
    expect(findInvalidSignedIntentParams(params, NOW)).toContain("vmProvider");
    expect(rawIntentCanonicalString(params)).not.toBe(canonicalIntentString(buildPaymentBodyFromIntent(params)));
  });

  it("still accepts the vmProvider alias on an unsigned URL", () => {
    expect(findInvalidSignedIntentParams(new URLSearchParams({ uid: "1", vmProvider: "lxd" }), NOW)).toEqual([]);
  });

  it("generic: every listed bad shape has raw canonical != body canonical, every flagged link is non-empty", () => {
    const shapes: Array<(p: URLSearchParams) => void> = [
      (p) => p.append("vmp", "lxd"),
      (p) => p.delete("tenantType"),
      (p) => p.set("tenant", "other"),
      (p) => { p.delete("vmp"); p.set("vmProvider", "lxd"); },
    ];
    for (const mutate of shapes) {
      const params = agentPodLxd();
      mutate(params);
      expect(rawIntentCanonicalString(params)).not.toBe(canonicalIntentString(buildPaymentBodyFromIntent(params)));
      expect(findInvalidSignedIntentParams(params, NOW).length).toBeGreaterThan(0);
    }
  });

  it("rawIntentCanonicalString ignores sig and non-signed keys", () => {
    const params = agentPodLxd();
    const before = rawIntentCanonicalString(params);
    params.set("test", "true");
    params.set("sig", "other");
    expect(rawIntentCanonicalString(params)).toBe(before);
    expect(before).not.toContain("sig=");
  });
});
