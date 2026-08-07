/**
 * The callback allowlist is a CROSS-SERVICE CONTRACT (OpenClawBot#3600).
 *
 * `sendCallback` will only POST a verified-payment webhook to a host on
 * `CALLBACK_URL_ALLOWLIST`. OpenClawBot builds that URL from its own
 * `DOMAIN_SUFFIX`. The two services deploy independently, so nothing forces
 * them to agree — and when they disagree the failure is SILENT: the payment
 * stays `verified`, no webhook fires, no retry exists, and the customer
 * receives nothing.
 *
 * That is not hypothetical. Two separate outages came from exactly this gap:
 *
 *   1. OpenClawBot defaulted its callback to `console.<suffix>`, which was
 *      never on this list. Production escaped only because a k8s env var
 *      overrode it to an `admin.` host.
 *   2. Fixing (1) pointed the callback at `admin.openclaw.agentlabs.cc` —
 *      OpenClawBot's real `DOMAIN_SUFFIX` — which was ALSO not on this list.
 *      That shipped and broke crypto checkout in production.
 *
 * So this file exists to make the contract fail LOUDLY here, in a unit test
 * with no network and no secrets, instead of silently in production.
 *
 * If OpenClawBot changes its domain suffix, this test must change in the same
 * change-set. That coupling is the entire point — do not "fix" a failure here
 * by deleting the case.
 */
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.ts";

/**
 * Every host OpenClawBot can legitimately build a crypto callback for.
 *
 * Mirrors `CRYPTO_CALLBACK_ALLOWED_HOSTS` in OpenClawBot `src/config.ts`.
 * Both suffixes are live during the vibebrowser.app -> agentlabs.cc migration,
 * exactly as OpenClawBot's `DOMAINS.cors` already covers both.
 */
const OPENCLAWBOT_CALLBACK_HOSTS = [
  // OpenClawBot prod runs DOMAIN_SUFFIX=openclaw.agentlabs.cc, so this is the
  // host it actually builds today. Its absence caused the second outage.
  "admin.openclaw.agentlabs.cc",
  // Still live, and what PUBLIC_BASE_URL pointed at before the fix.
  "admin.openclaw.vibebrowser.app",
];

describe("callback allowlist — cross-service contract with OpenClawBot", () => {
  const allowlist = loadConfig().callbackAllowlist;

  it.each(OPENCLAWBOT_CALLBACK_HOSTS)(
    "accepts %s — the host OpenClawBot actually builds",
    (host) => {
      expect(
        allowlist,
        `"${host}" is missing from CALLBACK_URL_ALLOWLIST. sendCallback would ` +
          `refuse the webhook for a VERIFIED payment, so the customer would pay ` +
          `and receive nothing, with no retry and no record (OpenClawBot#3600).`,
      ).toContain(host);
    },
  );

  it("keeps the payment-service domain", () => {
    expect(allowlist).toContain("pay.agentlabs.cc");
  });

  it("is not empty — an empty list silently drops every callback", () => {
    // `env(...).split(",").filter(Boolean)` yields [] for an empty override,
    // which would refuse 100% of webhooks while looking configured.
    expect(allowlist.length).toBeGreaterThan(0);
  });

  it("contains no scheme, path or port — sendCallback compares URL.hostname", () => {
    for (const host of allowlist) {
      expect(host, `"${host}" must be a bare hostname`).not.toMatch(/^https?:\/\//);
      expect(host, `"${host}" must not contain a path`).not.toContain("/");
      expect(host, `"${host}" must not contain a port`).not.toMatch(/:\d+$/);
      expect(host.trim(), `"${host}" has surrounding whitespace`).toBe(host);
    }
  });

  it("still EXCLUDES the console. hosts — they do not serve the webhook", () => {
    // Guards against over-correcting: the first outage was caused by building
    // callbacks for `console.`, and the right fix was to stop building them,
    // not to widen the SSRF boundary until it stopped complaining.
    expect(allowlist).not.toContain("console.openclaw.agentlabs.cc");
    expect(allowlist).not.toContain("console.openclaw.vibebrowser.app");
  });
});
