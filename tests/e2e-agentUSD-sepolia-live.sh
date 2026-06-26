#!/usr/bin/env bash
#
# Fully-automated, single-command, cross-service crypto top-up E2E on the REAL
# Ethereum Sepolia chain using the REAL agentUSD (aUSD) token. No Anvil, no
# Supabase, no prod deploy, no human steps, no browser.
#
# Flow:
#   1. Real on-chain aUSD transfer (5 aUSD) test wallet -> payments recipient.
#   2. Real CryptoPayments verify+callback logic (mock-DB wrapper) verifies that
#      on-chain tx and fires a signed HMAC callback.
#   3. A local callback receiver verifies the HMAC exactly like OpenClawBot does.
#   4. OpenClawBot's REAL crypto-webhook credit logic is driven with that live
#      callback payload and asserts the test user is credited the small pack ($5).
#
# Prints "LIVE E2E PASS" and exits 0 only when every real-path assertion holds.
#
set -euo pipefail

# ----------------------------------------------------------------------------
# Config (all real values)
# ----------------------------------------------------------------------------
REPO="/Users/engineer/workspace/CryptoPayments"
OCB="/Users/engineer/workspace/OpenClawBot"

CONTRACT="0x76B2AeC049e93FB53f210a4B0f02fe3Dee6514C3"   # agentUSD, Eth Sepolia, 6 dec
RECIPIENT="0xF08E2a9D128827615Fca921f278b7bFCBac895E2"  # payments owner / recipient
SENDER="0x64cd33D639Cbb0b461c64ec989a7d9789d701a30"     # test wallet (holds aUSD+gas)
RPC="https://ethereum-sepolia-rpc.publicnode.com"
WALLET_JSON="$REPO/testnet/wallet-1.json"

AMOUNT="5000000"          # 5 aUSD (6 decimals) == small pack ($5)
CALLBACK_SECRET="testsecret"
SERVER_PORT="9971"
CALLBACK_PORT="9972"
TEST_UID="77777"
# POST /api/payment requires auth (initData | apiKey | signed checkout intent).
# Configure the server with an API key and send it on the request so the E2E
# exercises the real auth path instead of relying on open access.
API_KEY_E2E="e2e-test-key"

export PATH="$HOME/.foundry/bin:$PATH"

SERVER_LOG="$(mktemp -t ocb_e2e_server.XXXXXX)"
CALLBACK_FILE="$(mktemp -t ocb_e2e_callback.XXXXXX)"
CB_PY="$(mktemp -t ocb_e2e_cbrecv.XXXXXX).py"
SERVER_PID=""
CB_PID=""

# ----------------------------------------------------------------------------
# Cleanup
# ----------------------------------------------------------------------------
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$CB_PID" ] && kill "$CB_PID" 2>/dev/null || true
  pkill -f "e2e-server-wrapper.ts" 2>/dev/null || true
  pkill -f "$CB_PY" 2>/dev/null || true
  rm -f "$SERVER_LOG" "$CALLBACK_FILE" "$CB_PY" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

die() {
  echo ""
  echo "LIVE E2E FAIL: $*" >&2
  exit 1
}

# ----------------------------------------------------------------------------
# 0. Preflight: tooling + real balances (report exact diagnostics, never fake)
# ----------------------------------------------------------------------------
echo "== [0] preflight =="
command -v cast >/dev/null 2>&1 || die "cast (foundry) not found on PATH ($HOME/.foundry/bin)"
command -v python3 >/dev/null 2>&1 || die "python3 not found"
[ -f "$WALLET_JSON" ] || die "wallet file missing: $WALLET_JSON"

BLOCK="$(cast block-number --rpc-url "$RPC" 2>&1)" || die "RPC unreachable: $BLOCK"
echo "   RPC ok, head block $BLOCK"

ETH_WEI="$(cast balance "$SENDER" --rpc-url "$RPC")"
AUSD_BAL="$(cast call "$CONTRACT" 'balanceOf(address)(uint256)' "$SENDER" --rpc-url "$RPC" | awk '{print $1}')"
echo "   sender ETH(wei)=$ETH_WEI  aUSD(raw)=$AUSD_BAL"
# gas floor ~0.001 ETH; aUSD must cover the transfer
python3 - "$ETH_WEI" "$AUSD_BAL" "$AMOUNT" <<'PY' || die "insufficient gas or aUSD in test wallet (see diagnostic above)"
import sys
eth_wei = int(sys.argv[1]); ausd = int(sys.argv[2]); amount = int(sys.argv[3])
if eth_wei < 1_000_000_000_000_000:  # 0.001 ETH
    print(f"   DIAG: gas too low: {eth_wei} wei < 0.001 ETH"); sys.exit(1)
if ausd < amount:
    print(f"   DIAG: aUSD too low: {ausd} < {amount}"); sys.exit(1)
print("   balances sufficient")
PY

KEY="$(python3 -c "import json;print(json.load(open('$WALLET_JSON'))['privateKey'])")"
[ -n "$KEY" ] || die "could not read privateKey from $WALLET_JSON"

# ----------------------------------------------------------------------------
# 1. REAL on-chain aUSD transfer (cast send waits for the receipt)
# ----------------------------------------------------------------------------
echo "== [1] real aUSD transfer: 5 aUSD $SENDER -> $RECIPIENT =="
SEND_JSON="$(cast send "$CONTRACT" 'transfer(address,uint256)' "$RECIPIENT" "$AMOUNT" \
  --private-key "$KEY" --rpc-url "$RPC" --json)" || die "cast send failed: $SEND_JSON"
TX_HASH="$(echo "$SEND_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin)['transactionHash'])")"
SEND_STATUS="$(echo "$SEND_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status'))")"
[ -n "$TX_HASH" ] || die "no transactionHash from cast send"
echo "   txHash=$TX_HASH status=$SEND_STATUS"

# Poll the receipt until mined+successful (real-chain timing safety net).
echo "   waiting for receipt confirmation..."
MINED=""
for i in $(seq 1 60); do
  RC="$(cast receipt "$TX_HASH" --rpc-url "$RPC" --json 2>/dev/null || true)"
  if [ -n "$RC" ]; then
    ST="$(echo "$RC" | python3 -c "import json,sys
try:
  d=json.load(sys.stdin); print(d.get('status'))
except Exception: print('')" 2>/dev/null || true)"
    if [ "$ST" = "0x1" ]; then MINED="1"; break; fi
    if [ "$ST" = "0x0" ]; then die "transfer reverted on-chain (status 0x0) tx=$TX_HASH"; fi
  fi
  sleep 3
done
[ -n "$MINED" ] || die "transfer not mined within timeout: $TX_HASH"
echo "   confirmed (status 0x1)"

# ----------------------------------------------------------------------------
# 2. Callback receiver — verifies HMAC exactly like OpenClawBot (x-signature)
# ----------------------------------------------------------------------------
echo "== [2] start callback receiver on :$CALLBACK_PORT =="
cat > "$CB_PY" <<'PYEOF'
import http.server, json, hmac, hashlib, os

PORT = int(os.environ["CB_PORT"])
SECRET = os.environ["CB_SECRET"].encode()
OUT = os.environ["CB_OUT"]

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        body = self.rfile.read(n)
        sig = self.headers.get("X-Signature", "")
        ts = self.headers.get("X-Timestamp", "")
        expected = hmac.new(SECRET, body, hashlib.sha256).hexdigest()
        valid = hmac.compare_digest(expected, sig)
        try:
            payload = json.loads(body)
        except Exception:
            payload = None
        with open(OUT, "w") as f:
            json.dump({
                "rawBody": body.decode("utf-8", errors="replace"),
                "signature": sig,
                "timestamp": ts,
                "sigValid": valid,
                "payload": payload,
            }, f)
        self.send_response(200)
        self.end_headers()
    def log_message(self, *a):
        pass

http.server.HTTPServer(("", PORT), Handler).serve_forever()
PYEOF
: > "$CALLBACK_FILE"   # truncate so a stale file is never read
CB_PORT="$CALLBACK_PORT" CB_SECRET="$CALLBACK_SECRET" CB_OUT="$CALLBACK_FILE" python3 "$CB_PY" &
CB_PID=$!
sleep 1
kill -0 "$CB_PID" 2>/dev/null || die "callback receiver failed to start"
echo "   receiver up (pid $CB_PID)"

# ----------------------------------------------------------------------------
# 3. Start the REAL CryptoPayments server (mock-DB wrapper) against real Sepolia
# ----------------------------------------------------------------------------
echo "== [3] start CryptoPayments server on :$SERVER_PORT =="
(
  cd "$REPO"
  AGENT_USD_CONTRACT="$CONTRACT" \
  RPC_ETH_SEPOLIA="$RPC" \
  WALLET_ETH_SEPOLIA="$RECIPIENT" \
  CALLBACK_SECRET="$CALLBACK_SECRET" \
  API_KEY="$API_KEY_E2E" \
  PORT="$SERVER_PORT" \
  exec npx tsx tests/e2e-server-wrapper.ts
) > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

echo "   waiting for /api/health..."
READY=""
for i in $(seq 1 60); do
  if curl -sf "http://localhost:$SERVER_PORT/api/health" >/dev/null 2>&1; then READY="1"; break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || die "server exited early; log:
$(cat "$SERVER_LOG")"
  sleep 1
done
[ -n "$READY" ] || die "server never became healthy; log:
$(cat "$SERVER_LOG")"
echo "   server healthy"

# ----------------------------------------------------------------------------
# 4. POST /api/payment — verify the REAL on-chain tx for the small top-up
# ----------------------------------------------------------------------------
echo "== [4] POST /api/payment (token=ausd topup=small) =="
REQ_BODY="$(python3 - "$TX_HASH" "$TEST_UID" "$CALLBACK_PORT" "$API_KEY_E2E" <<'PY'
import json, sys
tx, uid, cbport, api_key = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
print(json.dumps({
    "txHash": tx,
    "chainId": "eth_sepolia",
    "token": "ausd",
    "idType": "tg",
    "uid": uid,
    "topup": "small",
    "apiKey": api_key,
    "callbackUrl": f"http://localhost:{cbport}",
}))
PY
)"
RESP="$(curl -s -X POST "http://localhost:$SERVER_PORT/api/payment" \
  -H "Content-Type: application/json" -d "$REQ_BODY")"
echo "   response: $RESP"

# ----------------------------------------------------------------------------
# 5. Assert the verify response (status=verified, topup_id=small, amount=$5)
# ----------------------------------------------------------------------------
echo "== [5] assert verify response =="
python3 - "$RESP" <<'PY' || die "verify-response assertion failed (see above)"
import json, sys
r = json.loads(sys.argv[1])
p = r.get("payment") or {}
errs = []
if p.get("status") != "verified":
    errs.append(f"payment.status={p.get('status')!r} != 'verified'")
if p.get("topup_id") != "small":
    errs.append(f"payment.topup_id={p.get('topup_id')!r} != 'small'")
amt = p.get("amount_usd")
if amt is None or abs(float(amt) - 5.0) > 1e-9:
    errs.append(f"payment.amount_usd={amt!r} != 5")
if errs:
    print("   DIAG: " + "; ".join(errs)); sys.exit(1)
print(f"   verified: status={p['status']} topup_id={p['topup_id']} amount_usd={p['amount_usd']}")
PY

# ----------------------------------------------------------------------------
# 6. Assert the signed callback (HMAC valid, event + topup correct)
# ----------------------------------------------------------------------------
echo "== [6] assert signed callback =="
GOT=""
for i in $(seq 1 30); do
  if [ -s "$CALLBACK_FILE" ]; then GOT="1"; break; fi
  sleep 1
done
[ -n "$GOT" ] || die "callback never received from payments server"
python3 - "$CALLBACK_FILE" <<'PY' || die "callback assertion failed (see above)"
import json, sys
d = json.load(open(sys.argv[1]))
errs = []
if not d.get("sigValid"):
    errs.append("X-Signature HMAC did NOT verify against CALLBACK_SECRET")
pl = d.get("payload") or {}
if pl.get("event") != "payment.verified":
    errs.append(f"event={pl.get('event')!r} != 'payment.verified'")
pay = pl.get("payment") or {}
if pay.get("topup") != "small":
    errs.append(f"payment.topup={pay.get('topup')!r} != 'small'")
if errs:
    print("   DIAG: " + "; ".join(errs)); sys.exit(1)
print(f"   callback ok: sigValid=True event={pl['event']} payment.topup={pay['topup']} txHash={pay.get('txHash')}")
PY

# ----------------------------------------------------------------------------
# 7. CROSS-SERVICE: drive OpenClawBot's REAL credit logic with the live payload
# ----------------------------------------------------------------------------
echo "== [7] OpenClawBot credit half (real handler, live callback) =="
(
  cd "$OCB"
  OCB_REPO="$OCB" \
  CB_PAYLOAD_FILE="$CALLBACK_FILE" \
  CALLBACK_SECRET="$CALLBACK_SECRET" \
  TEST_UID="$TEST_UID" \
  npx tsx "$REPO/tests/ocb-credit-assert.ts"
) || die "OpenClawBot credit assertion failed (see above)"

# ----------------------------------------------------------------------------
# 8. Done
# ----------------------------------------------------------------------------
echo ""
echo "================================================================"
echo "LIVE E2E PASS"
echo "  txHash:     $TX_HASH"
echo "  etherscan:  https://sepolia.etherscan.io/tx/$TX_HASH"
echo "  transfer:   5 aUSD ($SENDER -> $RECIPIENT) confirmed on Eth Sepolia"
echo "  verify:     CryptoPayments -> status=verified topup=small amount=\$5"
echo "  callback:   signed (HMAC-SHA256) and verified by the receiver"
echo "  credit:     OpenClawBot updateUser credited the small pack (+\$5)"
echo "================================================================"
exit 0
