/**
 * Regression test: full payment flow including 202-pending → poll → verified path.
 *
 * Covers the bug where a freshly-submitted tx returned "Verification failed:
 * Transaction receipt ... could not be found" instead of showing a retry spinner.
 *
 * All network I/O is mocked:
 *  - window.ethereum (injected provider) handles wallet interactions
 *  - Playwright route intercepts handle /api/* endpoints
 */
import { test, expect } from "@playwright/test";

const WALLET_ADDR  = "0x1234567890123456789012345678901234567890";
const RECIPIENT    = "0xaabbccddaabbccddaabbccddaabbccddaabbccdd"; // valid hex — no ENS lookup
const TOKEN_ADDR   = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // valid hex ERC-20 stub
const TX_HASH      = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const PAYMENT_ID   = 99;

/** Minimal AppConfig that the SPA accepts without hitting real endpoints. */
const MOCK_CONFIG = {
  wallets: {
    base:        RECIPIENT,
    eth:         RECIPIENT,
    arbitrum:    RECIPIENT,
    sol:         "",
    ton:         "",
    base_sepolia: RECIPIENT,
    eth_sepolia:  RECIPIENT,
  },
  prices: { starter: 10, pro: 25, enterprise: 99 },
  tokens: {
    base:         { usdc: TOKEN_ADDR, usdt: TOKEN_ADDR, ausd: TOKEN_ADDR },
    eth:          { usdc: TOKEN_ADDR, usdt: TOKEN_ADDR, ausd: TOKEN_ADDR },
    arbitrum:     { usdc: TOKEN_ADDR, usdt: TOKEN_ADDR, ausd: TOKEN_ADDR },
    base_sepolia: { usdc: TOKEN_ADDR, usdt: TOKEN_ADDR, ausd: TOKEN_ADDR },
    eth_sepolia:  { usdc: TOKEN_ADDR, usdt: TOKEN_ADDR, ausd: TOKEN_ADDR },
    sol:          { usdc: "", usdt: "", ausd: "" },
    ton:          { usdc: "", usdt: "", ausd: "" },
  },
};

const PENDING_PAYMENT = {
  id: PAYMENT_ID, status: "pending", tx_hash: TX_HASH,
  chain_id: "base_sepolia", token: "ausd", amount_usd: 0, uid: "test123", id_type: "tg",
};
const VERIFIED_PAYMENT = { ...PENDING_PAYMENT, status: "verified", plan_id: "starter", amount_usd: 10 };

/**
 * Inject a minimal EIP-1193 provider that handles all calls ethers.js makes
 * during an ERC-20 transfer: account discovery, chain switch, gas estimation, send.
 */
async function injectMockEthereum(page: any, txHash: string) {
  await page.addInitScript(
    ({ walletAddr, txHash }: { walletAddr: string; txHash: string }) => {
      const listeners: Record<string, Function[]> = {};
      const eth = {
        isMetaMask: true,
        selectedAddress: walletAddr,
        on(ev: string, cb: Function)  { (listeners[ev] ??= []).push(cb); return eth; },
        removeListener(ev: string, cb: Function) {
          listeners[ev] = (listeners[ev] ?? []).filter(f => f !== cb); return eth;
        },
        emit(ev: string, ...a: unknown[]) { (listeners[ev] ?? []).forEach(f => f(...a)); },
        async request({ method }: { method: string; params?: unknown[] }): Promise<unknown> {
          switch (method) {
            case "eth_requestAccounts":
            case "eth_accounts":               return [walletAddr];
            case "eth_chainId":                return "0x14a34"; // base-sepolia 84532
            case "net_version":                return "84532";
            case "wallet_switchEthereumChain":
            case "wallet_addEthereumChain":    return null;
            case "wallet_requestPermissions":  return [{ parentCapability: "eth_accounts" }];
            case "eth_getTransactionCount":    return "0x1";
            case "eth_estimateGas":            return "0x14000";
            case "eth_gasPrice":               return "0x3b9aca00";
            case "eth_maxFeePerGas":           return "0x77359400";
            case "eth_maxPriorityFeePerGas":   return "0x3b9aca00";
            case "eth_feeHistory":             return {
              baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"],
              gasUsedRatio: [0.5], reward: [["0x3b9aca00"]], oldestBlock: "0x1",
            };
            case "eth_sendTransaction":        return txHash;
            // ERC-20 call (balanceOf / allowance) — return 32-byte 0 (success)
            case "eth_call":                   return "0x" + "0".repeat(64);
            // Ethers v6 polls this after eth_sendTransaction to build TransactionResponse.
            // Must include gas (→gasLimit) AND v/r/s so Signature.from() succeeds.
            case "eth_getTransactionByHash":   return {
              hash: txHash,
              blockHash: "0x" + "a".repeat(64),
              blockNumber: "0x1",
              transactionIndex: "0x0",
              from: walletAddr,
              to: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
              value: "0x0",
              gas: "0x14000",
              gasPrice: "0x3b9aca00",
              nonce: "0x1",
              input: "0xa9059cbb",
              type: "0x0",   // legacy type avoids EIP-1559 field checks
              chainId: "0x14a34",
              // Signature — fake but parseable by ethers Signature.from()
              v: "0x1b",
              r: "0xa1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4",
              s: "0xe5f6a7b8e5f6a7b8e5f6a7b8e5f6a7b8e5f6a7b8e5f6a7b8e5f6a7b8e5f6a7b8",
            };
            case "eth_getTransactionReceipt":  return null; // not mined — API handles this
            case "eth_blockNumber":            return "0x1";
            case "eth_getBlockByNumber":       return {
              number: "0x1", hash: "0x" + "a".repeat(64), parentHash: "0x" + "0".repeat(64),
              baseFeePerGas: "0x3b9aca00", gasLimit: "0x1c9c380", gasUsed: "0x0",
              miner: walletAddr, nonce: "0x0000000000000000", timestamp: "0x0", transactions: [],
            };
            default: console.warn("[eth mock] unhandled:", method); return null;
          }
        },
      };
      (window as any).ethereum = eth;
      setTimeout(() => {
        eth.emit("accountsChanged", [walletAddr]);
        eth.emit("chainChanged", "0x14a34");
      }, 100);
    },
    { walletAddr: WALLET_ADDR, txHash },
  );
}

/** Wire up config + payment API mocks for a given page. */
async function mockApis(page: any, {
  postStatus = 202,
  postBody = { payment: PENDING_PAYMENT, pending: true },
  pollResponses = [{ payment: PENDING_PAYMENT }, { payment: PENDING_PAYMENT }, { payment: VERIFIED_PAYMENT }],
}: {
  postStatus?: number;
  postBody?: object;
  pollResponses?: object[];
} = {}) {
  let pollCount = 0;

  await page.route("**/api/config", (r: any) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_CONFIG) }),
  );

  await page.route("**/api/payment", async (r: any) => {
    if (r.request().method() !== "POST") return r.continue();
    await r.fulfill({ status: postStatus, contentType: "application/json", body: JSON.stringify(postBody) });
  });

  await page.route(`**/api/payment/${PAYMENT_ID}`, async (r: any) => {
    const body = pollResponses[Math.min(pollCount++, pollResponses.length - 1)];
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  return () => pollCount; // getter for assertion
}

/** Navigate, select Base Sepolia + aUSD, connect mock wallet. Returns getPollCount fn. */
async function setupPayPage(page: any) {
  await page.goto("/pay?plan=starter&uid=test123&idtype=tg&test=true");
  await expect(page.locator("h1")).toContainText("Pay with Crypto", { timeout: 15_000 });

  // Select Base Sepolia testnet
  await page.getByRole("button", { name: /Base Sepolia/i }).click();

  // Select aUSD token
  await page.getByRole("button", { name: "aUSD" }).click();

  // Connect browser wallet (injected mock ethereum)
  await page.locator('button[title="Connect browser wallet"]').click();

  // Wait for Pay button — confirms wallet is connected
  await expect(page.getByRole("button", { name: /Pay \$10\.00 aUSD/i })).toBeVisible({ timeout: 10_000 });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe("Payment flow — pending → poll → verified", () => {

  test("202 response: shows spinner, polls, then shows 'Payment verified!'", async ({ page }) => {
    const getPollCount = await mockApis(page, {
      postStatus: 202,
      postBody: { payment: PENDING_PAYMENT, pending: true },
      pollResponses: [
        { payment: PENDING_PAYMENT },   // poll 1 — still pending
        { payment: PENDING_PAYMENT },   // poll 2 — still pending
        { payment: VERIFIED_PAYMENT },  // poll 3 — confirmed
      ],
    });
    await injectMockEthereum(page, TX_HASH);
    await setupPayPage(page);

    await page.getByRole("button", { name: /Pay \$10\.00 aUSD/i }).click();

    // KEY regression assertion: spinner must appear, NOT an error message
    await expect(page.getByText(/Waiting for confirmation/i)).toBeVisible({ timeout: 10_000 });

    // After polling resolves (3 polls × 3s = ~9s), success must appear
    await expect(page.getByText(/Payment verified!/i)).toBeVisible({ timeout: 30_000 });

    // Confirm polling actually happened
    expect(getPollCount()).toBeGreaterThanOrEqual(3);
  });

  test("500 server error: shows error message, no spinner", async ({ page }) => {
    await mockApis(page, {
      postStatus: 500,
      postBody: { error: "Transfer not found or not to our wallet" },
    });
    await injectMockEthereum(page, TX_HASH);
    await setupPayPage(page);

    await page.getByRole("button", { name: /Pay \$10\.00 aUSD/i }).click();

    await expect(page.getByText(/Transfer not found or not to our wallet/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Waiting for confirmation/i)).not.toBeVisible();
  });

  test("409 duplicate tx: shows already-submitted error", async ({ page }) => {
    await mockApis(page, {
      postStatus: 409,
      postBody: { error: "Transaction already submitted" },
    });
    await injectMockEthereum(page, TX_HASH);
    await setupPayPage(page);

    await page.getByRole("button", { name: /Pay \$10\.00 aUSD/i }).click();

    await expect(page.getByText(/already submitted/i)).toBeVisible({ timeout: 10_000 });
  });

  test("200 immediate verification: shows success without spinner", async ({ page }) => {
    await mockApis(page, {
      postStatus: 200,
      postBody: { payment: VERIFIED_PAYMENT },
    });
    await injectMockEthereum(page, TX_HASH);
    await setupPayPage(page);

    await page.getByRole("button", { name: /Pay \$10\.00 aUSD/i }).click();

    await expect(page.getByText(/Payment verified!/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Waiting for confirmation/i)).not.toBeVisible();
  });
});
