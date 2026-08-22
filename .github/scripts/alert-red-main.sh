#!/usr/bin/env bash
# Alert on red main (NO auto-revert) — ported from AgentPod's
# .github/scripts/alert-red-main.sh (AGE-971: AgentPod had a working
# red-main alert; CryptoPayments had zero equivalent, which is why two weeks
# of red `E2E – Telegram top-up` on main paged nobody). Keep in sync with
# AgentPod's copy when either changes; there is no cross-repo reusable
# workflow yet (see AGE-971 for why: AgentPod is private, CryptoPayments is
# public, and org-level Actions access policies would need an admin change
# to allow calling a private repo's reusable workflow from a public one).
#
# Originally extracted from AgentPod's
# .github/workflows/auto-revert-red-main.yml so the logic is testable.
#
# Env (GitHub Actions job env, unchanged): GH_TOKEN, BAD_SHA, RUN_URL, RUN_ID,
# TG_TOKEN, TG_ADMINS, SENTRY_DSN.
#
# Adds a SHA-scoped dedupe gate (#2602): if the offending PR already carries a
# `<!-- red-main-alert-sha:$BAD_SHA -->` marker comment, this exact SHA has
# already paged admins once — skip re-notifying (e.g. a manual `gh run rerun`
# of the same failed run re-fires this workflow for an already-known
# breakage). A genuinely new/different BAD_SHA has no matching marker and
# always notifies. If no PR number can be resolved from the commit subject,
# there is no comment thread to dedupe against, so we proceed with the alert
# (residual risk, logged below).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASSIFY_SCRIPT="$SCRIPT_DIR/../../scripts/classify-e2e-lease-outcome.sh"

# AGE-663: this workflow pages off the WHOLE `CI / CD` run's conclusion
# (workflow_run), which by design stays `failure` even when the ONLY
# failing job is `journey-telegram-hermes-max` losing the shared
# telegram-account-6668889106 lease race — that job's own `result` is kept
# `failure` on purpose so `prd-flow-summary`/flowCoverage still reports
# missing PRD coverage for the run (AGE-512). `notify-on-failure`
# (bot-image.yml) stays quiet for that specific case via the job's
# `lease_contention` output (both its own journey OR-branch AND, since
# AGE-831, its `prd-flow-summary` OR-branch — AGE-663 alone left that
# second branch paging unconditionally on every lease-contention-only run,
# measured 9/9 in AGE-670, because `prd-flow-summary` has no concept of
# lease_contention and fails on ANY non-success journey result by design).
# This workflow has no such per-job signal to read — it only sees the
# run-level conclusion. Without this check, a run that failed ONLY on lease
# contention would still page here even after notify-on-failure went silent
# on it.
#
# Classifies EVERY failing job's log with the same, already load-bearing
# scripts/classify-e2e-lease-outcome.sh (AGE-579, also used by
# payments-integrity.yml's stripe-topup-userflow and bot-image.yml's
# journey-telegram-hermes-max). Returns 0 (skip the page) only if EVERY
# failing job classifies as lease contention. Fails OPEN toward paging on
# any ambiguity — a job whose log can't be fetched, a run with no resolvable
# failing jobs, or a classifier miss on even one job all still page, same
# convention as the residual-risk logging below for the no-PR-number case.
lease_contention_only_run() {
  local run_id="$1"

  # AGE-971: this classifier is AgentPod-specific (its shared telegram-
  # account lease race). Other repos reusing this script (e.g. CryptoPayments)
  # have no equivalent classifier script — treat that as "nothing to
  # classify", not an error, and fail open to paging (same default as every
  # other ambiguous case below).
  if [ ! -f "$CLASSIFY_SCRIPT" ]; then
    echo "no classify script at ${CLASSIFY_SCRIPT} — lease-contention classification not available in this repo, failing open (will page)"
    return 1
  fi

  if [ -z "$run_id" ]; then
    echo "no RUN_ID available — cannot classify failing jobs, failing open (will page)"
    return 1
  fi

  local jobs_json
  jobs_json="$(gh run view "$run_id" --json jobs 2>/dev/null || true)"
  if [ -z "$jobs_json" ]; then
    echo "could not fetch job list for run ${run_id} — failing open (will page)"
    return 1
  fi

  local failed_ids
  failed_ids="$(printf '%s' "$jobs_json" | jq -r '(.jobs // [])[] | select(.conclusion=="failure") | .databaseId' 2>/dev/null || true)"
  if [ -z "$failed_ids" ]; then
    echo "no failing jobs resolved from run ${run_id}'s job list — failing open (will page)"
    return 1
  fi

  local tmp
  tmp="$(mktemp -d)"

  local id
  for id in $failed_ids; do
    local log="${tmp}/${id}.log"
    if ! gh api "repos/${GITHUB_REPOSITORY}/actions/jobs/${id}/logs" > "$log" 2>/dev/null; then
      echo "job ${id}: could not fetch its log — treating as a real failure (will page)"
      rm -rf "$tmp"
      return 1
    fi
    if ! "$CLASSIFY_SCRIPT" "$log" >/dev/null 2>&1; then
      echo "job ${id}: does not classify as shared-lease contention — treating as a real failure (will page)"
      rm -rf "$tmp"
      return 1
    fi
    echo "job ${id}: classifies as shared-lease contention (INFRA-BLOCKED, not a real failure)"
  done

  rm -rf "$tmp"
  return 0
}

notify() {
  local msg="$1"
  echo "$msg"
  if [ -z "${TG_TOKEN:-}" ] || [ -z "${TG_ADMINS:-}" ]; then return 0; fi
  local IFS=', '; read -ra _ids <<< "$TG_ADMINS"
  for id in "${_ids[@]}"; do
    [ -z "$id" ] && continue
    curl -sS --max-time 15 -o /dev/null -w "tg id=$id http=%{http_code}\n" \
      "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
      --data-urlencode chat_id="$id" --data-urlencode text="$msg" || true
  done
}

subject="$(git log -1 --format=%s "$BAD_SHA" 2>/dev/null || echo '<unknown>')"
echo "offending commit: $BAD_SHA — $subject"

if lease_contention_only_run "${RUN_ID:-}"; then
  echo "every failing job in run ${RUN_ID:-<unset>} classifies as shared-lease contention (INFRA-BLOCKED) — skipping page for ${BAD_SHA}"
  exit 0
fi

# Parse the PR number from the squash subject "... (#N)".
pr_num="$(printf '%s' "$subject" | grep -oE '\(#[0-9]+\)' | tail -1 | tr -dc '0-9' || true)"

marker="<!-- red-main-alert-sha:${BAD_SHA} -->"

if [ -n "${pr_num:-}" ]; then
  existing_comments="$(gh pr view "$pr_num" --json comments --jq '.comments[].body' 2>/dev/null || true)"
  if printf '%s' "$existing_comments" | grep -qF "$marker"; then
    echo "already alerted for SHA ${BAD_SHA} on PR #${pr_num} — skipping duplicate page"
    exit 0
  fi
else
  echo "no PR number resolved from subject — cannot SHA-dedupe, proceeding with alert (residual risk: repeated runs with no resolvable PR will re-page)"
fi

msg="🔴 Post-merge CI / CD is RED on main.
Commit: ${BAD_SHA} — ${subject}
Run: ${RUN_URL}

NOT auto-reverted (policy: a test/CI failure never auto-reverts a branch — too many flaky/infra false positives). Investigate: is it a real regression or flaky? Then fix-forward with a new PR, or manually revert ${BAD_SHA} if the merge truly broke main."

notify "$msg"

# Sentry event — fire-and-forget, non-blocking. Deduped/cooled-down (AGE-494)
# via the shared sentry-ci-capture.sh: the signature is deliberately just the
# source ('red-main-ci'), not the SHA, so a chronically-flapping job across
# MANY different merge SHAs (e.g. prd-flow-summary, AGE-512) collapses into
# one Sentry event per cooldown window instead of one per SHA. Telegram
# paging above is unaffected — it already has its own SHA/PR-marker dedup.
"$SCRIPT_DIR/sentry-ci-capture.sh" "red-main-ci" "$msg" "red-main-ci" || true

if [ -n "${pr_num:-}" ]; then
  gh pr comment "$pr_num" --body "🔴 Post-merge CI / CD went red after this merged: ${RUN_URL}

**Not auto-reverted** — flaky/infra post-merge failures used to revert correct merges, so auto-revert is disabled by policy. Please check whether this is a real regression (fix-forward) or a flaky run (re-run \`CI / CD\` on main), and manually revert ${BAD_SHA} only if main is genuinely broken.

${marker}" 2>/dev/null || true
fi
