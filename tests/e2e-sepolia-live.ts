#!/usr/bin/env bun
/**
 * tests/e2e-sepolia-live.ts
 *
 * Live E2E: crypto top-up (5 aUSD, Ethereum Sepolia) against the DEPLOYED
 * Supabase edge function. No mock DB, no local server, no cast, no Python.
 *
 * Default EDGE_URL: https://krjbwbvmrpazdmmjstzo.supabase.co/functions/v1/crypto-payments
 *
 * Required env (fail-fast, no defaults, no fallbacks):
 *   CHECKOUT_SECRET or CALLBACK_SECRET  — signs the checkout intent; never hardcoded
 *   testnet/wallet-1.json               — must exist; holds sender private key
 *
 * Optional env:
 *   EDGE_URL    override the deployed edge URL
 *   SEPOLIA_RPC override the Sepolia JSON-RPC URL
 *   TEST_UID    Telegram user ID for the test payment (default: "77777")
 *   TEST_WALLET path to wallet JSON file (default: testnet/wallet-1.json)
 *
 * Exit 0 only when every assertion passes.
 * Any failure → console.error with exact values + process.exit(1).
 */

import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  formatEther,
  getAddress,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_EDGE_URL =
  "https://krjbwbvmrpazdmmjstzo.supabase.co/functions/v1/crypto-payments";

/**
 * Known aUSD (AgentUSD) contract on Ethereum Sepolia.
 * Used ONLY if the edge /api/config doesn't report tokens.eth_sepolia.ausd.
 * This is a documented constant, not a silent error-swallow.
 */
const KNOWN_AUSD_ADDRESS: Address =
  "0x76B2AeC049e93FB53f210a4B0f02fe3Dee6514C3";

const AMOUNT_RAW = 5_000_000n; // 5 aUSD at 6 decimals
const AMOUNT_USD = 5;
const GAS_FLOOR_WEI = 1_000_000_000_000_000n; // 0.001 ETH minimum for gas

const ERC20_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

interface WalletJson {
  privateKey: string;
  address: string;
}

interface EdgeConfig {
  wallets: Record<string, string>;
  tokens: Record<string, Record<string, string>>;
}

interface PaymentResult {
  status: string;
  topup_id: string | null;
  amount_usd: number | string;
}

interface PaymentResponse {
  payment?: PaymentResult;
  error?: string;
}

// ── Step 1: Preflight ─────────────────────────────────────────────────────────

interface PreflightResult {
  edgeUrl: string;
  secret: string;
  rpcUrl: string;
  walletPath: string;
  uid: string;
}

function preflight(): PreflightResult {
  const edgeUrl = process.env.EDGE_URL ?? DEFAULT_EDGE_URL;

  // Require a signing secret — never hardcode a fallback.
  const secret =
    process.env.CHECKOUT_SECRET ?? process.env.CALLBACK_SECRET ?? "";
  if (!secret) {
    console.error(
      "PREFLIGHT FAIL: neither CHECKOUT_SECRET nor CALLBACK_SECRET is set.\n" +
        "  One of these is required to sign the checkout intent sent to the edge.\n" +
        "  Set the same value that the deployed edge is configured with.",
    );
    process.exit(1);
  }

  const walletPath = resolve(
    process.env.TEST_WALLET ?? "testnet/wallet-1.json",
  );
  if (!existsSync(walletPath)) {
    console.error(`PREFLIGHT FAIL: wallet file not found: ${walletPath}`);
    process.exit(1);
  }

  const rpcUrl =
    process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
  const uid = process.env.TEST_UID ?? "77777";

  console.log("[0] preflight OK");
  console.log(`    edge:   ${edgeUrl}`);
  console.log(`    rpc:    ${rpcUrl}`);
  console.log(`    wallet: ${walletPath}`);
  console.log(`    uid:    ${uid}`);
  return { edgeUrl, secret, rpcUrl, walletPath, uid };
}

// ── Step 2: Load edge config ──────────────────────────────────────────────────

interface EdgeAssets {
  recipient: Address;
  ausdAddress: Address;
}

async function loadConfig(edgeUrl: string): Promise<EdgeAssets> {
  const url = `${edgeUrl}/api/config`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    console.error(`CONFIG FAIL: GET ${url} unreachable: ${err}`);
    process.exit(1);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error(
      `CONFIG FAIL: GET ${url} → HTTP ${resp.status}\n  body: ${body}`,
    );
    process.exit(1);
  }

  const cfg = (await resp.json()) as EdgeConfig;

  const recipientRaw = cfg?.wallets?.eth_sepolia;
  if (!recipientRaw) {
    console.error(
      `CONFIG FAIL: wallets.eth_sepolia missing from /api/config response:\n` +
        JSON.stringify(cfg, null, 2),
    );
    process.exit(1);
  }
  const recipient = getAddress(recipientRaw);

  // Prefer the address the edge reports; fall back to the documented constant.
  const ausdRaw = cfg?.tokens?.eth_sepolia?.ausd;
  const ausdAddress: Address = ausdRaw
    ? getAddress(ausdRaw)
    : KNOWN_AUSD_ADDRESS;
  if (!ausdRaw) {
    console.log(
      `    [config] tokens.eth_sepolia.ausd absent from edge; ` +
        `using documented constant ${KNOWN_AUSD_ADDRESS}`,
    );
  }

  console.log("[1] edge config loaded");
  console.log(`    recipient:    ${recipient}`);
  console.log(`    aUSD address: ${ausdAddress}`);
  return { recipient, ausdAddress };
}

// ── Step 3: Check balances ────────────────────────────────────────────────────

async function checkBalances(
  sender: Address,
  ausdAddress: Address,
  rpcUrl: string,
): Promise<void> {
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  });

  const [ethBalance, ausdBalance] = await Promise.all([
    publicClient.getBalance({ address: sender }),
    publicClient.readContract({
      address: ausdAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [sender],
    }),
  ]);

  console.log("[2] balances");
  console.log(`    ETH:  ${formatEther(ethBalance)} (${ethBalance} wei)`);
  console.log(
    `    aUSD: ${formatUnits(ausdBalance, 6)} (${ausdBalance} raw)`,
  );

  if (ethBalance < GAS_FLOOR_WEI) {
    console.error(
      `BALANCE FAIL: ETH too low.\n` +
        `  have: ${ethBalance} wei (${formatEther(ethBalance)} ETH)\n` +
        `  need: ≥${GAS_FLOOR_WEI} wei (0.001 ETH) for gas`,
    );
    process.exit(1);
  }
  if (ausdBalance < AMOUNT_RAW) {
    console.error(
      `BALANCE FAIL: aUSD insufficient.\n` +
        `  have: ${formatUnits(ausdBalance, 6)} aUSD (${ausdBalance} raw)\n` +
        `  need: ≥${formatUnits(AMOUNT_RAW, 6)} aUSD (${AMOUNT_RAW} raw)`,
    );
    process.exit(1);
  }
}

// ── Step 4: Real on-chain transfer ────────────────────────────────────────────

async function sendAusd(
  privateKey: Hex,
  rpcUrl: string,
  ausdAddress: Address,
  recipient: Address,
): Promise<Hex> {
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(rpcUrl),
  });

  console.log(
    `[3] transfer ${formatUnits(AMOUNT_RAW, 6)} aUSD (${account.address} → ${recipient})`,
  );

  let hash: Hex;
  try {
    hash = await walletClient.writeContract({
      address: ausdAddress,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [recipient, AMOUNT_RAW],
    });
  } catch (err) {
    console.error(`TRANSFER FAIL: writeContract threw:\n  ${err}`);
    process.exit(1);
  }
  console.log(`    txHash: ${hash}`);
  console.log("    waiting for receipt (up to 180s)...");

  let receipt: Awaited<
    ReturnType<typeof publicClient.waitForTransactionReceipt>
  >;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: 180_000,
    });
  } catch (err) {
    console.error(
      `TRANSFER FAIL: waitForTransactionReceipt timed out or threw:\n  ${err}`,
    );
    process.exit(1);
  }

  if (receipt.status !== "success") {
    console.error(
      `TRANSFER FAIL: transaction reverted on-chain.\n` +
        `  status: ${receipt.status}\n` +
        `  block:  ${receipt.blockNumber}\n` +
        `  txHash: ${hash}`,
    );
    process.exit(1);
  }
  console.log(
    `    confirmed — block=${receipt.blockNumber} status=${receipt.status}`,
  );
  return hash;
}

// ── Step 5: Sign checkout intent ──────────────────────────────────────────────

interface SignedIntent {
  sig: string;
  exp: number;
}

/**
 * Builds and signs the checkout intent exactly as verifyCheckoutIntent in
 * src/server.ts expects (read from source, not summarised):
 *
 *   URLSearchParams with only the present optional fields, plus uid/idtype/exp.
 *   Entries sorted by key.localeCompare(), joined with "\n".
 *   HMAC-SHA256-hex keyed with CHECKOUT_SECRET (falls back to CALLBACK_SECRET).
 *
 * For a topup call with no callbackUrl, no plan, no tenantType/vmProvider/hostType:
 *   keys in canonical (sorted): amountUsd, exp, idtype, topup, uid
 *   canonical form: "amountUsd=<v>\nexp=<v>\nidtype=tg\ntopup=small\nuid=<v>"
 */
function signIntent(
  secret: string,
  opts: { uid: string; topup: string; amountUsd: string; exp: number },
): SignedIntent {
  const params = new URLSearchParams();
  // Conditional fields first (mirrors server.ts order of if-blocks):
  params.set("topup", opts.topup); // present: body.topup
  params.set("uid", opts.uid);
  params.set("idtype", "tg"); // always set
  params.set("amountUsd", opts.amountUsd); // present: body.amountUsd
  params.set("exp", String(opts.exp));
  // No callbackUrl → no "callback" param.
  // No plan, tenantType, vmProvider, hostType.

  const canonical = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const sig = createHmac("sha256", secret).update(canonical).digest("hex");

  const sortedKeys = [...params.keys()].sort((a, b) => a.localeCompare(b));
  console.log(
    `[4] sign intent — keys=[${sortedKeys.join(",")}] exp=${opts.exp}`,
  );
  return { sig, exp: opts.exp };
}

// ── Step 6: Submit payment ────────────────────────────────────────────────────

async function submitPayment(
  edgeUrl: string,
  opts: { txHash: Hex; uid: string; exp: number; sig: string },
): Promise<PaymentResponse> {
  const url = `${edgeUrl}/api/payment`;
  const body = {
    txHash: opts.txHash,
    chainId: "eth_sepolia",
    token: "ausd",
    idType: "tg",
    uid: opts.uid,
    topup: "small",
    amountUsd: String(AMOUNT_USD),
    exp: String(opts.exp),
    sig: opts.sig,
    // No callbackUrl: the deployed edge cannot reach a localhost receiver;
    // callback delivery is out of scope for this test (see reflection below).
  };

  console.log(`[5] POST ${url}`);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`PAYMENT FAIL: fetch threw:\n  ${err}`);
    process.exit(1);
  }

  const json = (await resp.json()) as PaymentResponse;
  console.log(`    HTTP ${resp.status} — ${JSON.stringify(json)}`);

  if (!resp.ok) {
    console.error(
      `PAYMENT FAIL: edge returned HTTP ${resp.status}.\n` +
        `  error: ${json.error ?? JSON.stringify(json)}`,
    );
    process.exit(1);
  }
  return json;
}

// ── Step 7: Assert verified ───────────────────────────────────────────────────

function assertVerified(json: PaymentResponse): void {
  const p = json.payment;
  if (!p) {
    console.error(
      `ASSERT FAIL: response has no .payment field.\n` +
        `  full response: ${JSON.stringify(json)}`,
    );
    process.exit(1);
  }

  const errs: string[] = [];
  if (p.status !== "verified") {
    errs.push(
      `payment.status=${JSON.stringify(p.status)}  (expected "verified")`,
    );
  }
  if (p.topup_id !== "small") {
    errs.push(
      `payment.topup_id=${JSON.stringify(p.topup_id)}  (expected "small")`,
    );
  }
  if (Math.abs(Number(p.amount_usd) - AMOUNT_USD) > 1e-9) {
    errs.push(
      `payment.amount_usd=${JSON.stringify(p.amount_usd)}  (expected ${AMOUNT_USD})`,
    );
  }

  if (errs.length > 0) {
    console.error(`ASSERT FAIL:\n  ${errs.join("\n  ")}`);
    console.error(`  full response: ${JSON.stringify(json)}`);
    process.exit(1);
  }

  console.log(
    `[6] assert PASS — status=${p.status} topup_id=${p.topup_id} amount_usd=${p.amount_usd}`,
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { edgeUrl, secret, rpcUrl, walletPath, uid } = preflight();
  const { recipient, ausdAddress } = await loadConfig(edgeUrl);

  const walletJson = JSON.parse(
    readFileSync(walletPath, "utf8"),
  ) as WalletJson;
  const rawPk = walletJson.privateKey;
  const privateKey = (rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`) as Hex;
  const sender = privateKeyToAccount(privateKey).address;
  console.log(`    sender: ${sender}`);

  await checkBalances(sender, ausdAddress, rpcUrl);
  const txHash = await sendAusd(privateKey, rpcUrl, ausdAddress, recipient);

  const exp = Math.floor(Date.now() / 1000) + 600; // 10-minute window
  const { sig } = signIntent(secret, {
    uid,
    topup: "small",
    amountUsd: String(AMOUNT_USD),
    exp,
  });

  const json = await submitPayment(edgeUrl, { txHash, uid, exp, sig });
  assertVerified(json);

  console.log("");
  console.log("================================================================");
  console.log("LIVE E2E PASS");
  console.log(`  txHash:    ${txHash}`);
  console.log(`  etherscan: https://sepolia.etherscan.io/tx/${txHash}`);
  console.log(`  transfer:  5 aUSD (${sender} → ${recipient}) Eth Sepolia`);
  console.log(`  verified:  status=verified topup_id=small amount_usd=5`);
  console.log("================================================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
