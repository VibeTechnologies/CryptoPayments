#!/usr/bin/env bash
# payments-integrity-check.sh (AGE-988, child of AGE-986 Task 2)
#
# Calls GET /api/admin/integrity-check, which enforces the invariant:
#   "no payment_intent in the terminal `failed` state may have a tx_hash
#    that resolves to a CONFIRMED on-chain transfer."
#
# AGE-986's post-mortem found two production rows that violated exactly this
# invariant (pi_b20ad22cf80342b8bbccd833184a3994, pi_16e3e4b10d914acd8abb11bd263da831)
# and NO check ever caught it — this script/workflow is that missing check.
#
# On violation this script:
#   1. exits non-zero, so the calling workflow step (and therefore the whole
#      job) goes red — the ONLY currently-required signal per AGE-988 req #2,
#   2. also proactively pages a human, reusing the exact notify pattern
#      already built for red-main alerting (.github/scripts/alert-red-main.sh,
#      AGE-971/AGE-964): a Telegram message to every id in ADMIN_TELEGRAM_IDS,
#      plus a deduped Sentry event via the shared sentry-ci-capture.sh. A red
#      job nobody is told about is the AGE-964 failure repeating (per AGE-988's
#      explicit requirement) — do not rely on GitHub Actions' own red-job UI.
#
# Never silently swallows a transport error either: if the endpoint can't be
# reached at all, or secrets aren't configured, this exits non-zero too
# (fail-closed on the HTTP call, unlike sentry-ci-capture.sh's own internal
# fail-open-on-notify-plumbing convention, which still applies to the
# Telegram/Sentry side-channel below).
#
# Usage (env):
#   CRYPTO_PAYMENTS_URL, CRYPTO_PAYMENTS_API_KEY   required; same secrets as
#                                                   reconcile-cron.yml
#   TG_TOKEN, TG_ADMINS                            optional; same secrets as
#                                                   alert-red-main.yml
#                                                   (CI_NOTIFY_BOT_TOKEN /
#                                                   ADMIN_TELEGRAM_IDS)
#   SENTRY_DSN, SENTRY_CI_DEDUP_STATE              optional; same as
#                                                   alert-red-main.yml
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

notify() {
  local msg="$1"
  echo "$msg"
  if [ -z "${TG_TOKEN:-}" ] || [ -z "${TG_ADMINS:-}" ]; then
    echo "(TG_TOKEN/TG_ADMINS not set — skipping Telegram page)"
    return 0
  fi
  local IFS=', '
  read -ra _ids <<<"$TG_ADMINS"
  for id in "${_ids[@]}"; do
    [ -z "$id" ] && continue
    curl -sS --max-time 15 -o /dev/null -w "tg id=$id http=%{http_code}\n" \
      "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
      --data-urlencode chat_id="$id" --data-urlencode text="$msg" || true
  done
}

if [ -z "${CRYPTO_PAYMENTS_URL:-}" ] || [ -z "${CRYPTO_PAYMENTS_API_KEY:-}" ]; then
  echo "::error::CRYPTO_PAYMENTS_URL / CRYPTO_PAYMENTS_API_KEY secrets not set on this repo — cannot run the AGE-988 payments-failed/confirmed-transfer invariant check." >&2
  exit 1
fi

resp=$(curl -sS -w '\n%{http_code}' \
  "${CRYPTO_PAYMENTS_URL%/}/api/admin/integrity-check" \
  -H "x-api-key: ${CRYPTO_PAYMENTS_API_KEY}")
body=$(echo "$resp" | sed '$d')
code=$(echo "$resp" | tail -n1)
echo "$body"

if [ "$code" -ge 300 ] && [ "$code" -ne 409 ]; then
  echo "::error::integrity-check endpoint returned unexpected HTTP $code" >&2
  msg="🔴 AGE-988 payments integrity check could not run: HTTP ${code} from ${CRYPTO_PAYMENTS_URL}. Investigate the endpoint/secrets — this check being unreachable is itself a gap in the AGE-986 detection coverage."
  notify "$msg"
  "$SCRIPT_DIR/sentry-ci-capture.sh" "payments-integrity-unreachable" "$msg" "payments-integrity" || true
  exit 1
fi

violation_count=$(echo "$body" | jq -r '.violations | length' 2>/dev/null || echo "?")

if [ "$code" -eq 409 ] || { [ "$violation_count" != "?" ] && [ "$violation_count" -gt 0 ]; }; then
  echo "::error::AGE-988 invariant violated: ${violation_count} failed payment(s) have a confirmed on-chain transfer." >&2
  violations_summary=$(echo "$body" | jq -c '.violations' 2>/dev/null || echo "$body")
  msg="🔴 AGE-988 payments integrity check FAILED: ${violation_count} payment(s) recorded as 'failed' have a CONFIRMED on-chain transfer (customer paid, we show it failed — see AGE-986 for the two rows this exact bug already produced).

Violations: ${violations_summary}

This does NOT auto-mutate any row (detection only). Reconcile manually per AGE-986's process before touching these rows."
  notify "$msg"
  "$SCRIPT_DIR/sentry-ci-capture.sh" "payments-integrity-violation" "$msg" "payments-integrity" || true
  exit 1
fi

echo "AGE-988 payments integrity check: OK, 0 violations."
exit 0
