#!/usr/bin/env bash
# sentry-ci-capture.sh — shared, deduped Sentry event POST for CI-side alert
# scripts (AGE-494).
#
# Why this exists
# ----------------
# `openclaw-ci` (DSN `SENTRY_CI_DSN`, used by `auto-revert-red-main.yml`,
# `bot-image.yml`'s `notify-on-failure`, and `publish-chrome-sync.yml`) shares
# ONE org-wide free-tier quota (5000 errors/mo) with `openclaw-bot` and
# `litellm` — see docs/sentry-project-migration.md. AGE-132 measured
# `openclaw-ci` going from 0 accepted/day through 08-15 to 16 (08-16) and 74
# (08-18), almost entirely `notify-on-failure` firing once per push-to-main
# whenever `prd-flow-summary` is red — which, per AGE-512, is BY DESIGN
# whenever any live PRD journey (flaky, real-infra e2e) is not green. That
# made it red on effectively every push in the measured window, so every
# push-to-main also fired an undeduped Sentry POST.
#
# This mirrors `src/utils/sentry-dedup.ts` (AGE-65)'s per-signature cooldown,
# adapted for GitHub Actions' ephemeral runners: the caller is responsible for
# restoring/saving the state file across runs via `actions/cache` (same idiom
# as the `fleet-update-success` snapshot in bot-image.yml — restore with a
# run-id key + a prefix `restore-keys` fallback, save under the run-id key).
# This script only reads/writes whatever state file path it is given; it does
# not know about GitHub Actions cache.
#
# Does NOT touch Telegram/PR-comment alerting — those stay unbounded (already
# governed by their own logic, e.g. alert-red-main.sh's SHA/PR-marker dedup)
# because the shared-quota risk here is Sentry ingestion specifically, and a
# human/agent still needs to see every real occurrence to act on it.
#
# Usage:
#   SENTRY_DSN=... SENTRY_CI_DEDUP_STATE=.sentry-ci-dedup.json \
#     .github/scripts/sentry-ci-capture.sh <signature> <message> [source-tag]
#
# Env:
#   SENTRY_DSN                    required; empty/unset -> no-op (matches the
#                                 existing "fire-and-forget" guard at all 3
#                                 call sites this replaces)
#   SENTRY_CI_DEDUP_STATE         state file path (default: .sentry-ci-dedup.json)
#   SENTRY_CI_DEDUP_COOLDOWN_SEC  per-signature cooldown in seconds, default
#                                 21600 (6h) — same default as
#                                 src/utils/sentry-dedup.ts
#   SENTRY_CI_DEDUP_DISABLE       "true" restores unconditional send (kill
#                                 switch, same convention as
#                                 SENTRY_DEDUP_ENABLED=false on the bot side)
#
# Never fails the calling workflow step: any internal error is caught and the
# script exits 0 (fail-open on notification plumbing, same convention as the
# inline curl calls it replaces). Fails OPEN toward sending, not suppressing,
# on any dedup-state read/parse error — we would rather send one extra event
# than silently swallow a real one.
set -uo pipefail

SIGNATURE="${1:?usage: sentry-ci-capture.sh <signature> <message> [source-tag]}"
MESSAGE="${2:?usage: sentry-ci-capture.sh <signature> <message> [source-tag]}"
SOURCE_TAG="${3:-ci}"

STATE_FILE="${SENTRY_CI_DEDUP_STATE:-.sentry-ci-dedup.json}"
COOLDOWN_SEC="${SENTRY_CI_DEDUP_COOLDOWN_SEC:-21600}"

if [ -z "${SENTRY_DSN:-}" ]; then
  exit 0
fi

now=$(date +%s)
key_hash=$(printf '%s' "$SIGNATURE" | sha256sum | cut -d' ' -f1 | cut -c1-16)

last_sent=0
suppressed=0
if [ -s "$STATE_FILE" ]; then
  last_sent=$(jq -r --arg k "$key_hash" '.[$k].lastSent // 0' "$STATE_FILE" 2>/dev/null || echo 0)
  suppressed=$(jq -r --arg k "$key_hash" '.[$k].suppressed // 0' "$STATE_FILE" 2>/dev/null || echo 0)
fi
case "$last_sent" in ''|*[!0-9]*) last_sent=0 ;; esac
case "$suppressed" in ''|*[!0-9]*) suppressed=0 ;; esac

age=$(( now - last_sent ))

if [ "${SENTRY_CI_DEDUP_DISABLE:-}" != "true" ] && [ "$last_sent" -gt 0 ] && [ "$age" -lt "$COOLDOWN_SEC" ]; then
  echo "sentry-ci-capture: signature '${SIGNATURE}' (${key_hash}) within ${COOLDOWN_SEC}s cooldown (last sent ${age}s ago) — skipping Sentry POST. Telegram/PR alerting is unaffected."
  new_suppressed=$(( suppressed + 1 ))
  tmp="$(mktemp)"
  if jq --arg k "$key_hash" --argjson last "$last_sent" --argjson sup "$new_suppressed" \
      '.[$k] = {lastSent: $last, suppressed: $sup}' "$STATE_FILE" >"$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    printf '{"%s": {"lastSent": %d, "suppressed": %d}}\n' "$key_hash" "$last_sent" "$new_suppressed" >"$STATE_FILE"
    rm -f "$tmp"
  fi
  exit 0
fi

sentry_key=$(echo "$SENTRY_DSN" | sed 's|https://||' | cut -d@ -f1)
sentry_rest=$(echo "$SENTRY_DSN" | sed 's|https://||' | cut -d@ -f2)
sentry_host=$(echo "$sentry_rest" | cut -d/ -f1)
sentry_project=$(echo "$sentry_rest" | cut -d/ -f2-)
sentry_ts=$(date -u +%Y-%m-%dT%H:%M:%S)

sentry_payload=$(python3 -c "
import json, sys, uuid
msg, sig, src, sup = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
tags = {'source': src, 'dedup_signature': sig[:200]}
extra = {}
if sup > 0:
    tags['dedup'] = 'repeat'
    extra['dedup.suppressed_since_last'] = sup
else:
    tags['dedup'] = 'first'
print(json.dumps({
    'event_id': uuid.uuid4().hex,
    'timestamp': '${sentry_ts}',
    'platform': 'other',
    'level': 'error',
    'logger': 'ci',
    'message': msg[:500],
    'tags': tags,
    'extra': extra,
}))
" "$MESSAGE" "$SIGNATURE" "$SOURCE_TAG" "$suppressed" 2>/dev/null)

if [ -n "$sentry_payload" ]; then
  curl -s --max-time 10 \
    "https://${sentry_host}/api/${sentry_project}/store/" \
    -H "X-Sentry-Auth: Sentry sentry_version=7, sentry_key=${sentry_key}" \
    -H "Content-Type: application/json" \
    -d "$sentry_payload" >/dev/null 2>&1 || true
fi

tmp="$(mktemp)"
if [ -s "$STATE_FILE" ] && jq --arg k "$key_hash" --argjson last "$now" \
    '.[$k] = {lastSent: $last, suppressed: 0}' "$STATE_FILE" >"$tmp" 2>/dev/null; then
  mv "$tmp" "$STATE_FILE"
else
  printf '{"%s": {"lastSent": %d, "suppressed": 0}}\n' "$key_hash" "$now" >"$STATE_FILE"
  rm -f "$tmp"
fi
exit 0
