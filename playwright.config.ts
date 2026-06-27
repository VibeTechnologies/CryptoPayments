import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  timeout: 120_000,
  // Serial: both spec files share wallet-1 for on-chain txs — parallel nonce collisions break beforeAll
  workers: 1,
  use: {
    baseURL: process.env.BASE_URL ?? 'https://pay.agentlabs.cc',
    headless: true,
  },
});
