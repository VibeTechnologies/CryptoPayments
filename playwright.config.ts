import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:3033",
    headless: true,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "tsx src/server.ts",
    port: 3033,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: "3033",
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-key",
      WALLET_BASE: "0xDeadBeef0000000000000000000000000000Base",
      WALLET_ETH: "0xDeadBeef00000000000000000000000000000Eth",
      WALLET_TON: "EQTestTonWalletAddress",
      WALLET_SOL: "TestSolWalletPublicKey",
      API_KEY: "e2e-test-key",
      CALLBACK_SECRET: "e2e-callback-secret",
      TELEGRAM_BOT_TOKEN: "123456:E2ETestToken",
      PRICE_STARTER: "10",
      PRICE_PRO: "25",
      PRICE_MAX: "100",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
