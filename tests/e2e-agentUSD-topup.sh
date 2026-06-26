#!/usr/bin/env bash
# E2E test: agentUSD Anvil testnet deploy + mint + crypto topup callback
#
# Flow:
#   1. Start Anvil (chain-id 84532 = base_sepolia, port 8546)
#   2. Deploy agentUSD ERC20 on Anvil via forge script
#   3. Transfer 5 aUSD from deployer → recipient wallet (captures txHash)
#   4. Start Python callback receiver on port 9998
#   5. Start CryptoPayments server (wrapper with mock DB + patched TOKEN_ADDRESSES)
#   6. POST /api/payment with topup=small + real txHash
#   7. Assert callback payload contains payment.topup=small
set -euo pipefail

ANVIL="${HOME}/.foundry/bin/anvil"
FORGE="${HOME}/.foundry/bin/forge"
CAST="${HOME}/.foundry/bin/cast"
ANVIL_PORT=8546
ANVIL_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ANVIL_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
# Anvil account #1 — our "merchant" receiving wallet
RECIPIENT="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
AGENTUSED_DIR="/Users/engineer/workspace/agentUSD"
CRYPTOPAY_DIR="/Users/engineer/workspace/CryptoPayments"
SERVER_PORT=9999
CALLBACK_PORT=9998
CALLBACK_LOG="/tmp/e2e_callback_log.json"

ANVIL_PID=""
SERVER_PID=""
PY_PID=""

cleanup() {
  echo ""
  echo "==> Cleaning up..."
  [ -n "$PY_PID" ]     && kill "$PY_PID"     2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$ANVIL_PID" ]  && kill "$ANVIL_PID"  2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── Step 1: Start Anvil ───────────────────────────────────────────────────────
echo "==> Starting Anvil on port $ANVIL_PORT (chain-id 84532 = base_sepolia)..."
"$ANVIL" \
  --port "$ANVIL_PORT" \
  --chain-id 84532 \
  --silent \
  2>/dev/null &
ANVIL_PID=$!
sleep 2

# Verify Anvil is up
"$CAST" block-number --rpc-url "http://localhost:$ANVIL_PORT" >/dev/null 2>&1 || {
  echo "ERROR: Anvil failed to start"; exit 1
}
echo "  Anvil running (PID $ANVIL_PID)"

# ── Step 2: Deploy agentUSD ───────────────────────────────────────────────────
echo ""
echo "==> Deploying agentUSD on Anvil..."
cd "$AGENTUSED_DIR"

FORGE_OUT=$("$FORGE" script script/DeployAgentUSD.s.sol \
  --rpc-url "http://localhost:$ANVIL_PORT" \
  --private-key "$ANVIL_KEY" \
  --broadcast \
  2>&1)

# Extract contract address from forge logs
AGENT_USD=$(echo "$FORGE_OUT" | grep "AgentUSD deployed to:" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)

# Fallback: last 0x address in output
if [ -z "$AGENT_USD" ]; then
  AGENT_USD=$(echo "$FORGE_OUT" | grep -oE '0x[0-9a-fA-F]{40}' | tail -1)
fi

if [ -z "$AGENT_USD" ]; then
  echo "ERROR: Could not extract agentUSD contract address from forge output:"
  echo "$FORGE_OUT"
  exit 1
fi

echo "  agentUSD deployed at: $AGENT_USD"

# Verify deployer has 10,000 aUSD balance
DEPLOYER_BALANCE=$("$CAST" call "$AGENT_USD" "balanceOf(address)(uint256)" "$ANVIL_ADDR" \
  --rpc-url "http://localhost:$ANVIL_PORT")
echo "  Deployer balance: $DEPLOYER_BALANCE (should be 10000000000)"

# ── Step 3: Transfer 5 aUSD deployer → recipient (real ERC20 transfer) ────────
echo ""
echo "==> Transferring 5 aUSD to recipient $RECIPIENT..."
# 5 aUSD = 5_000_000 (6 decimals)
SEND_OUT=$("$CAST" send "$AGENT_USD" \
  "transfer(address,uint256)" "$RECIPIENT" "5000000" \
  --private-key "$ANVIL_KEY" \
  --rpc-url "http://localhost:$ANVIL_PORT" \
  --json 2>&1)

TX_HASH=$(echo "$SEND_OUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    # cast --json may output transactionHash or hash
    print(d.get('transactionHash', d.get('hash', '')))
except Exception as e:
    print('', end='')
" 2>/dev/null)

# Fallback: parse non-JSON output
if [ -z "$TX_HASH" ]; then
  TX_HASH=$(echo "$SEND_OUT" | grep -E "^transactionHash\s+" | awk '{print $NF}' | head -1)
fi

if [ -z "$TX_HASH" ]; then
  echo "ERROR: Could not extract txHash from cast send output:"
  echo "$SEND_OUT"
  exit 1
fi

RECIPIENT_BALANCE=$("$CAST" call "$AGENT_USD" "balanceOf(address)(uint256)" "$RECIPIENT" \
  --rpc-url "http://localhost:$ANVIL_PORT")
echo "  txHash: $TX_HASH"
echo "  Recipient balance: $RECIPIENT_BALANCE (should be 5000000)"

# Save contract address for deployment.md
echo "AGENT_USD=$AGENT_USD" > "$AGENTUSED_DIR/.anvil-deploy.env"

# ── Step 4: Start callback receiver ──────────────────────────────────────────
echo ""
echo "==> Starting callback receiver on port $CALLBACK_PORT..."
rm -f "$CALLBACK_LOG"
python3 - <<'PYEOF' &
import http.server, json, threading, time

received = []
log_path = "/tmp/e2e_callback_log.json"

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        body = self.rfile.read(length)
        try:
            received.append(json.loads(body))
        except Exception:
            received.append({"_raw": body.decode("utf-8", errors="replace")})
        # Write immediately so the bash script can poll it
        with open(log_path, "w") as f:
            json.dump(received, f)
        self.send_response(200)
        self.end_headers()
    def log_message(self, *a):
        pass  # silence access logs

server = http.server.HTTPServer(("", 9998), Handler)
t = threading.Thread(target=server.serve_forever, daemon=True)
t.start()

# Keep alive for up to 60s
time.sleep(60)
PYEOF
PY_PID=$!
sleep 1
echo "  Callback receiver running (PID $PY_PID)"

# ── Step 5: Start CryptoPayments server (mock DB + patched token addresses) ──
echo ""
echo "==> Starting CryptoPayments server on port $SERVER_PORT..."
cd "$CRYPTOPAY_DIR"

AGENT_USD_CONTRACT="$AGENT_USD" \
  RPC_BASE_SEPOLIA="http://localhost:$ANVIL_PORT" \
  WALLET_BASE_SEPOLIA="$RECIPIENT" \
  CALLBACK_SECRET="testsecret" \
  PORT="$SERVER_PORT" \
  npx tsx tests/e2e-server-wrapper.ts \
  > /tmp/e2e_server.log 2>&1 &
SERVER_PID=$!

# Wait for server to be ready (poll /api/health)
echo "  Waiting for server ready..."
READY=0
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$SERVER_PORT/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" -eq 0 ]; then
  echo "ERROR: Server did not become ready in 30s. Log:"
  cat /tmp/e2e_server.log
  exit 1
fi
echo "  Server ready (PID $SERVER_PID)"

# ── Step 6: Submit payment ────────────────────────────────────────────────────
echo ""
echo "==> Submitting payment to /api/payment..."
echo "  txHash: $TX_HASH"
echo "  topup:  small"

PAYMENT_RESP=$(curl -s -X POST "http://localhost:$SERVER_PORT/api/payment" \
  -H "Content-Type: application/json" \
  -d "{
    \"txHash\":      \"$TX_HASH\",
    \"chainId\":     \"base_sepolia\",
    \"idType\":      \"tg\",
    \"uid\":         \"123456789\",
    \"topup\":       \"small\",
    \"callbackUrl\": \"http://localhost:$CALLBACK_PORT\"
  }")

echo "  Response: $PAYMENT_RESP"

HTTP_TOPUP_ID=$(echo "$PAYMENT_RESP" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    p = d.get('payment', {})
    print(p.get('topup_id', 'MISSING'))
except Exception as e:
    print('PARSE_ERROR:', e)
" 2>/dev/null)

HTTP_STATUS=$(echo "$PAYMENT_RESP" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    p = d.get('payment', {})
    print(p.get('status', 'MISSING'))
except Exception as e:
    print('PARSE_ERROR:', e)
" 2>/dev/null)

echo "  payment.status:   $HTTP_STATUS"
echo "  payment.topup_id: $HTTP_TOPUP_ID"

# ── Step 7: Wait for callback and assert ──────────────────────────────────────
echo ""
echo "==> Waiting for callback..."
CALLBACK_TOPUP="NO_CALLBACK"
for i in $(seq 1 15); do
  sleep 1
  # Flush the log from the Python server
  python3 -c "
import json, sys
try:
    with open('/tmp/e2e_callback_log.json') as f:
        events = json.load(f)
    if events:
        p = events[0].get('payment', events[0])
        print(p.get('topup', 'MISSING'))
    else:
        print('NO_CALLBACK')
except FileNotFoundError:
    print('NO_CALLBACK')
except Exception as e:
    print('ERROR:', e)
" 2>/dev/null > /tmp/e2e_topup_check.txt && true

  CALLBACK_TOPUP=$(cat /tmp/e2e_topup_check.txt 2>/dev/null || echo "NO_CALLBACK")
  if [ "$CALLBACK_TOPUP" != "NO_CALLBACK" ] && [ -n "$CALLBACK_TOPUP" ]; then
    break
  fi

  # Also check if callback data is in memory (Python saves to file at exit)
  # Trigger a manual save via sending SIGUSR1 if needed — just keep polling
done

# If still no callback file, force write from Python
if [ "$CALLBACK_TOPUP" = "NO_CALLBACK" ]; then
  # Give Python server one more second, then read any data it has
  kill -0 "$PY_PID" 2>/dev/null && kill "$PY_PID" 2>/dev/null
  sleep 2
  CALLBACK_TOPUP=$(python3 -c "
import json
try:
    with open('/tmp/e2e_callback_log.json') as f:
        events = json.load(f)
    if events:
        p = events[0].get('payment', events[0])
        print(p.get('topup', 'MISSING'))
    else:
        print('NO_CALLBACK')
except Exception as e:
    print('NO_CALLBACK')
" 2>/dev/null)
  PY_PID=""
fi

echo "  callback.payment.topup: $CALLBACK_TOPUP"

# ── Teardown ──────────────────────────────────────────────────────────────────
[ -n "$PY_PID" ]     && kill "$PY_PID"     2>/dev/null || true
[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
[ -n "$ANVIL_PID" ]  && kill "$ANVIL_PID"  2>/dev/null || true
ANVIL_PID=""
SERVER_PID=""
PY_PID=""

# ── Result ────────────────────────────────────────────────────────────────────
echo ""
echo "==================================================================="
if [ "$HTTP_STATUS" = "verified" ] && [ "$HTTP_TOPUP_ID" = "small" ] && [ "$CALLBACK_TOPUP" = "small" ]; then
  echo "E2E PASS: agentUSD testnet deploy + mint + crypto topup callback verified"
  echo "  Contract:           $AGENT_USD"
  echo "  txHash:             $TX_HASH"
  echo "  payment.status:     $HTTP_STATUS"
  echo "  payment.topup_id:   $HTTP_TOPUP_ID"
  echo "  callback.topup:     $CALLBACK_TOPUP"
  echo "==================================================================="
  exit 0
else
  echo "E2E FAIL"
  echo "  Contract:           $AGENT_USD"
  echo "  txHash:             $TX_HASH"
  echo "  Expected:  status=verified, topup_id=small, callback.topup=small"
  echo "  Got:       status=$HTTP_STATUS, topup_id=$HTTP_TOPUP_ID, callback.topup=$CALLBACK_TOPUP"
  echo "==================================================================="
  echo ""
  echo "Server log:"
  cat /tmp/e2e_server.log 2>/dev/null || true
  exit 1
fi
