/**
 * Playwright E2E: AppKit wallet connect buttons.
 *
 * Verifies the 3-button EVM wallet connect UI and the AppKit modal flow.
 * Tests run against a real built Next.js static export — no mocks.
 *
 * Requires:
 *   NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID — real Reown project ID
 *   BASE_URL — deployed URL
 */

import { test, expect } from "@playwright/test";

test.describe("Mobile Wallet QR Connect", () => {
  test("3 EVM wallet icon buttons are visible on Base chain", async ({ page }) => {
    await page.goto("/pay?plan=starter&uid=123456&idtype=tg&test=true");
    await page.waitForSelector('button[title="Connect browser wallet"]', { timeout: 10_000 });

    await expect(page.locator('button[title="Connect browser wallet"]')).toBeVisible();
    await expect(page.locator('button[title="Connect Base wallet"]')).toBeVisible();
    await expect(page.locator('button[title="Connect WalletConnect"]')).toBeVisible();
  });

  test("AppKit modal opens when clicking Connect Base wallet", async ({ page }) => {
    await page.goto("/pay?plan=starter&uid=123456&idtype=tg&test=true");
    await page.waitForSelector('button[title="Connect Base wallet"]', { timeout: 10_000 });
    await page.locator('button[title="Connect Base wallet"]').click();

    const modalHost = page.locator("appkit-modal, wui-modal, w3m-modal").first();
    await expect(modalHost).toBeAttached({ timeout: 8_000 });
    await expect(modalHost).toBeVisible({ timeout: 8_000 });

    const hasShadowContent = await page.evaluate(() => {
      const modal = document.querySelector("appkit-modal, wui-modal, w3m-modal");
      if (!modal || !modal.shadowRoot) return false;
      return modal.shadowRoot.children.length > 0 || modal.shadowRoot.childNodes.length > 0;
    });
    expect(hasShadowContent, "AppKit modal shadow root should have content").toBe(true);
  });

  test("Rabby configured as featured wallet in compiled bundle", async ({ page }) => {
    await page.goto("/pay?plan=starter&uid=123456&idtype=tg&test=true");
    await page.waitForSelector('button[title="Connect Base wallet"]', { timeout: 10_000 });
    await page.locator('button[title="Connect Base wallet"]').click();

    await page.locator("appkit-modal, wui-modal, w3m-modal").first().waitFor({
      state: "attached",
      timeout: 8_000,
    });

    // Verify Rabby's WalletConnect explorer ID is baked into the compiled JS bundle.
    // Wallet list rendering requires live WC explorer API — Tier 4 manual test on real device.
    const RABBY_WC_ID = "18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1";
    const rabbyConfigured = await page.evaluate(async (rabbyId) => {
      const scriptSrcs = Array.from(document.querySelectorAll("script[src]"))
        .map((s) => (s as HTMLScriptElement).src)
        .filter((src) => src.includes("/_next/"));
      for (const src of scriptSrcs) {
        try {
          const text = await fetch(src).then((r) => r.text());
          if (text.includes(rabbyId)) return true;
        } catch { /* ignore */ }
      }
      return false;
    }, RABBY_WC_ID);
    expect(rabbyConfigured, "Rabby WalletConnect ID must be present in compiled JS bundle").toBe(true);
  });

  test("Solana shows Connect Phantom, not EVM buttons", async ({ page }) => {
    await page.goto("/pay?plan=starter&uid=123456&idtype=tg");
    await page.waitForSelector("text=/Solana/i", { timeout: 10_000 });
    await page.locator("text=/Solana/i").first().click();

    await expect(page.locator('button:has-text("Connect Phantom")')).toBeVisible();
    await expect(page.locator('button[title="Connect Base wallet"]')).not.toBeVisible();
    await expect(page.locator('button[title="Connect WalletConnect"]')).not.toBeVisible();
  });

  // Regression: Coinbase Wallet mobile "no valid asset found"
  test("compiled bundle has eoaOnly coinbasePreference and no hardcoded wrong domain", async ({ page }) => {
    await page.goto("/pay?plan=starter&uid=123456&idtype=tg&test=true");
    await page.waitForSelector('button[title="Connect Base wallet"]', { timeout: 10_000 });

    const result = await page.evaluate(async () => {
      const scriptSrcs = Array.from(document.querySelectorAll("script[src]"))
        .map((s) => (s as HTMLScriptElement).src)
        .filter((src) => src.includes("/_next/"));

      let hasEoaOnly = false;
      let hasWrongDomain = false;

      for (const src of scriptSrcs) {
        try {
          const text = await fetch(src).then((r) => r.text());
          if (text.includes("eoaOnly")) hasEoaOnly = true;
          if (text.includes("pay.oclawbox.com")) hasWrongDomain = true;
        } catch { /* ignore */ }
      }
      return { hasEoaOnly, hasWrongDomain };
    });

    expect(result.hasEoaOnly, "coinbasePreference must be 'eoaOnly' in compiled bundle").toBe(true);
    expect(result.hasWrongDomain, "compiled bundle must NOT contain pay.oclawbox.com").toBe(false);
  });
});


