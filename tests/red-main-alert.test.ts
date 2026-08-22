/**
 * AGE-971 — CryptoPayments had zero red-main alerting: two weeks of red
 * `E2E – Telegram top-up` on `main` paged nobody because there was never a
 * workflow wired to watch it (only AgentPod had one, hard-scoped to itself).
 *
 * This is a regression test for the fix — it does not mock the alerting
 * logic. It runs the REAL `.github/scripts/alert-red-main.sh` (ported from
 * AgentPod, see that file's header) against a scratch git repo, stubbing
 * only the network/API boundary (`gh`, `curl`) the same way AgentPod's own
 * `red-main-alert-single-sender.test.ts` does. Live delivery to the real
 * Telegram channel is verified separately (see AGE-971 comment log), because
 * config review alone is not accepted as evidence of an end-to-end alert
 * path per repo policy.
 *
 * Two halves:
 *  1. Static wiring assertions on `.github/workflows/alert-red-main.yml` —
 *     the workflow names watched, the branch/event/permission gates. These
 *     are invisible at runtime and silently reversible by anyone editing the
 *     workflow.
 *  2. Real execution of `alert-red-main.sh` proving it actually pages when
 *     main goes red, actually dedupes a repeat alert for the same SHA, and
 *     gracefully skips (fails OPEN, i.e. still pages) the AgentPod-only
 *     lease-contention classifier that does not exist in this repo.
 */
import { execFileSync, execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const WORKFLOW_PATH = join(ROOT, ".github", "workflows", "alert-red-main.yml");
const SCRIPT_PATH = join(ROOT, ".github", "scripts", "alert-red-main.sh");

describe("alert-red-main.yml wiring (AGE-971, static)", () => {
  const workflowText = readFileSync(WORKFLOW_PATH, "utf8");

  it("watches all three main-line workflows (CI, E2E – Telegram top-up, E2E – Mobile Wallet QR Modal)", () => {
    expect(workflowText).toMatch(/workflows:\s*\n\s*-\s*"CI"/);
    expect(workflowText).toMatch(/-\s*"E2E – Telegram top-up"/);
    expect(workflowText).toMatch(/-\s*"E2E – Mobile Wallet QR Modal"/);
  });

  it("only fires on main, and only on a failed push (post-merge) run — never on PR-branch completions", () => {
    expect(workflowText).toMatch(/branches:\s*\[main\]/);
    expect(workflowText).toMatch(/github\.event\.workflow_run\.conclusion == 'failure'/);
    expect(workflowText).toMatch(/github\.event\.workflow_run\.event == 'push'/);
    expect(workflowText).toMatch(/github\.event\.workflow_run\.head_branch == 'main'/);
  });

  it("requests the actions:read permission alert-red-main.sh needs to fetch job logs", () => {
    expect(workflowText).toMatch(/actions:\s*read/);
  });

  it("invokes the real alert-red-main.sh script (not an inline reimplementation)", () => {
    expect(workflowText).toMatch(/run:\s*bash \.github\/scripts\/alert-red-main\.sh/);
  });
});

describe("alert-red-main.sh real execution (AGE-971)", () => {
  let workDir: string;
  let binDir: string;
  let ghCalls: string;
  let curlCalls: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "age971-red-main-repo-"));
    execSync("git init -q", { cwd: workDir });
    execSync("git config user.email test@example.com", { cwd: workDir });
    execSync("git config user.name Test", { cwd: workDir });
    writeFileSync(join(workDir, "f.txt"), "x");
    execSync("git add f.txt", { cwd: workDir });
    execSync('git commit -q -m "fix(pay): correct top-up retry (#77)"', { cwd: workDir });

    // Mirror the real script layout: script lives at <repo>/.github/scripts/,
    // so CLASSIFY_SCRIPT resolves to <repo>/scripts/classify-e2e-lease-outcome.sh
    // — which deliberately does NOT exist in CryptoPayments (AGE-971: that
    // classifier is AgentPod-specific).
    mkdirSync(join(workDir, ".github", "scripts"), { recursive: true });
    const scriptDest = join(workDir, ".github", "scripts", "alert-red-main.sh");
    writeFileSync(scriptDest, readFileSync(SCRIPT_PATH, "utf8"));
    chmodSync(scriptDest, 0o755);
    const sentryScriptDest = join(workDir, ".github", "scripts", "sentry-ci-capture.sh");
    writeFileSync(
      sentryScriptDest,
      readFileSync(join(ROOT, ".github", "scripts", "sentry-ci-capture.sh"), "utf8"),
    );
    chmodSync(sentryScriptDest, 0o755);
    expect(existsSync(join(workDir, "scripts", "classify-e2e-lease-outcome.sh"))).toBe(false);

    binDir = mkdtempSync(join(tmpdir(), "age971-stub-bin-"));
    ghCalls = join(workDir, "gh-calls.log");
    curlCalls = join(workDir, "curl-calls.log");
    writeFileSync(ghCalls, "");
    writeFileSync(curlCalls, "");

    // Stub `gh`: `gh run view` (no RUN_ID in these tests -> script fails open
    // before ever calling this), `gh pr view --json comments` (existing PR
    // comment marker, controlled per-test via GH_STUB_EXISTING_COMMENTS env),
    // `gh pr comment` (records what would have been posted), `gh api` (job
    // logs — unused since RUN_ID is unset in these tests).
    writeFileSync(
      join(binDir, "gh"),
      `#!/usr/bin/env bash
echo "$*" >> "${ghCalls}"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ "\${GH_STUB_EXISTING_COMMENTS:-}" != "" ]; then
    echo "{\\"comments\\":[{\\"body\\":\\"\${GH_STUB_EXISTING_COMMENTS}\\"}]}"
  else
    echo '{"comments":[]}'
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  exit 0
fi
exit 0
`,
    );
    chmodSync(join(binDir, "gh"), 0o755);

    writeFileSync(
      join(binDir, "curl"),
      `#!/usr/bin/env bash
echo "$*" >> "${curlCalls}"
echo -n "http=200"
`,
    );
    chmodSync(join(binDir, "curl"), 0o755);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  function runScript(env: Record<string, string>): string {
    const sha = execSync("git rev-parse HEAD", { cwd: workDir, encoding: "utf8" }).trim();
    return execFileSync("bash", [join(workDir, ".github", "scripts", "alert-red-main.sh")], {
      cwd: workDir,
      encoding: "utf8",
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        GH_TOKEN: "fake",
        BAD_SHA: sha,
        RUN_URL: "https://github.com/VibeTechnologies/CryptoPayments/actions/runs/123",
        GITHUB_REPOSITORY: "VibeTechnologies/CryptoPayments",
        TG_TOKEN: "fake-tg-token",
        TG_ADMINS: "111,222",
        SENTRY_DSN: "",
        ...env,
      },
      timeout: 15_000,
    });
  }

  it("pages Telegram on a real red-main run when no classify script exists in this repo (fails open, not silently skipped)", () => {
    const stdout = runScript({});
    expect(stdout).toMatch(/no classify script at .* — lease-contention classification not available in this repo, failing open \(will page\)/);

    const curlLog = readFileSync(curlCalls, "utf8");
    expect(curlLog).toMatch(/api\.telegram\.org\/bot/);
    expect(curlLog).toMatch(/chat_id=111/);
    expect(curlLog).toMatch(/chat_id=222/);

    const ghLog = readFileSync(ghCalls, "utf8");
    expect(ghLog).toMatch(/pr comment 77/);
    expect(stdout).toMatch(/NOT auto-reverted/);
    expect(stdout).toMatch(/fix\(pay\): correct top-up retry \(#77\)/);
  });

  it("does not re-page when the PR already carries the red-main-alert-sha marker for this exact SHA", () => {
    const sha = execSync("git rev-parse HEAD", { cwd: workDir, encoding: "utf8" }).trim();
    const stdout = runScript({ GH_STUB_EXISTING_COMMENTS: `already alerted <!-- red-main-alert-sha:${sha} -->` });

    expect(stdout).toMatch(/already alerted for SHA .* — skipping duplicate page/);
    const curlLog = readFileSync(curlCalls, "utf8");
    expect(curlLog).toBe("");
  });

  it("is a safe no-op (no curl call) when TG_TOKEN/TG_ADMINS are unset — never crashes the CI job", () => {
    runScript({ TG_TOKEN: "", TG_ADMINS: "" });
    const curlLog = readFileSync(curlCalls, "utf8");
    expect(curlLog).toBe("");
  });
});
