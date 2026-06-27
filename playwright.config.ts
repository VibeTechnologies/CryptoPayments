import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  timeout: 120_000,
  use: {
    baseURL: process.env.BASE_URL ?? 'https://pay.agentlabs.cc',
    headless: true,
  },
});
