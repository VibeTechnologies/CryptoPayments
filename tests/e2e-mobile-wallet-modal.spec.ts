/**
 * Playwright smoke test: AppKit mobile wallet QR modal.
 *
 * Verifies that clicking "Connect Mobile Wallet" on the payment page:
 * 1. Opens the AppKit modal (WalletConnect v2 QR + wallet list)
 * 2. Renders wallet options (shadow DOM web component)
 * 3. Shows Coinbase Wallet and Rabby as featured wallets
 * 4. Extension "Connect Wallet" button still present alongside the mobile button
 *
 * Requires:
 *   NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID — real Reown project ID (free: dashboard.reown.com)
 *   BASE_URL — deployed URL (Vercel preview or pay.agentlabs.cc)
 *
 * Does NOT test:
 *   - Actual QR scan (requires real mobile device — see .tasks/35/test-plan.md Tier 4)
 *   - WalletConnect session handshake
 *   - Transaction signing
 */

import { test, expect } from "@playwright/test";

test.describe("Mobile Wallet QR Connect", () => {
  test("AppKit modal opens with wallet options on Connect Mobile Wallet click", async ({ page }) => {
    await page.goto("/pay?plan=starter&uid=123456&idtype=tg&test=true");

    // Wait for config to load (chain selector must be visible)
    await page.waitForSelector('[data-testid="chain-selector"], button:has-text("Base")', {
      timeout: 10_000,
    });

    // Mobile connect button must be present
    const mobileBtn = page.locator('button:has-text("Connect Mobile Wallet")');
    await expect(mobileBtn).toBeVisible({ timeout: 5_000 });

    // Click it
    await mobileBtn.click();

    // AppKit renders as web components (shadow DOM).
    // Verify the modal web component host element is in the DOM.
    const modalHost = page.locator("appkit-modal, wui-modal, w3m-modal").first();
    await expect(modalHost).toBeAttached({ timeout: 8_000 });

    // Verify modal host is visible (non-zero bounding box or display:block)
    await expect(modalHost).toBeVisible({ timeout: 8_000 });

    // Verify modal has actual shadow root content via JS eval
    const hasShadowContent = await page.evaluate(() => {
      const modal = document.querySelector("appkit-modal, wui-modal, w3m-modal");
      if (!modal || !modal.shadowRoot) return false;
      return modal.shadowRoot.children.length > 0 || modal.shadowRoot.childNodes.length > 0;
    });
    expect(hasShadowContent, "AppKit modal shadow root should have content").toBe(true);
  });

  test("Coinbase Wallet visible and Rabby configured as featured wallet", async ({ page }) => {
    await page.goto("/pay?plan=starter&uid=123456&idtype=tg&test=true");
    await page.waitForSelector('button:has-text("Connect Mobile Wallet")', { timeout: 10_000 });
    await page.locator('button:has-text("Connect Mobile Wallet")').click();

    // Modal must be in DOM
    await page.locator("appkit-modal, wui-modal, w3m-modal").first().waitFor({
      state: "attached",
      timeout: 8_000,
    });

    // Coinbase Wallet is a built-in AppKit connector (WalletLink/Coinbase SDK) and
    // appears without requiring the WalletConnect explorer API. Assert it's visible.
    // Playwright's text locator pierces shadow DOM.
    await expect(page.locator("text=/Coinbase/i").first()).toBeVisible({ timeout: 20_000 });

    // Verify Rabby's WalletConnect explorer ID is in the compiled JS bundle.
    // Next.js bakes featuredWalletIds from appkit.ts into a JS chunk file.
    // We fetch all script chunks from the browser context to confirm the ID is present.
    // This is a config-level check: visual rendering of Rabby requires the WC explorer
    // API to have a verified domain (propagation) — Tier 4 manual test on real device.
    const RABBY_WC_ID = "18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1";
    const rabbyConfigured = await page.evaluate(async (rabbyId) => {
      const scriptSrcs = Array.from(document.querySelectorAll("script[src]"))
        .map((s) => (s as HTMLScriptElement).src)
        .filter((src) => src.includes("/_next/"));
      for (const src of scriptSrcs) {
        try {
          const text = await fetch(src).then((r) => r.text());
          if (text.includes(rabbyId)) return true;
        } catch {
          // ignore fetch errors for individual chunks
        }
      }
      return false;
    }, RABBY_WC_ID);
    expect(
      rabbyConfigured,
      "Rabby WalletConnect ID must be present in compiled JS bundle (appkit.ts → featuredWalletIds). " +
      "Visual rendering in wallet list = Tier 4 manual test requiring valid WC project domain.",
    ).toBe(true);
  });

  test("extension Connect Wallet button still visible for EVM", async ({ page }) => {
    // Simulate extension present
    await page.addInitScript(() => {
      Object.defineProperty(window, "ethereum", {
        value: { isMetaMask: true, request: () => Promise.reject(new Error("test")) },
        writable: true,
      });
    });

    await page.goto("/pay?plan=starter&uid=123456&idtype=tg");
    await page.waitForSelector('button:has-text("Connect Wallet")', { timeout: 10_000 });

    // Both buttons present
    await expect(page.locator('button:has-text("Connect Wallet")')).toBeVisible();
    await expect(page.locator('button:has-text("Connect Mobile Wallet")')).toBeVisible();
  });

  test("mobile button not shown for Solana chain", async ({ page }) => {
    await page.goto("/pay?plan=starter&uid=123456&idtype=tg");
    await page.waitForSelector("text=/Solana/i", { timeout: 10_000 });
    await page.locator("text=/Solana/i").first().click();

    await expect(page.locator('button:has-text("Connect Mobile Wallet")')).not.toBeVisible();
    await expect(page.locator('button:has-text("Connect Phantom")')).toBeVisible();
  });

  // Regression: Coinbase Wallet mobile "no valid asset found"
  // Fix: coinbasePreference changed to "eoaOnly" (bypasses Smart Wallet domain validation)
  //      metadata.url changed to use NEXT_PUBLIC_APP_URL (not hardcoded wrong domain)
  // This test verifies the compiled bundle — not mocks — so a config regression is caught at build time.
  test("compiled bundle has eoaOnly coinbasePreference and no hardcoded wrong domain", async ({ page }) => {
    await page.goto("/pay?plan=starter&uid=123456&idtype=tg&test=true");
    await page.waitForSelector('button:has-text("Connect Mobile Wallet")', { timeout: 10_000 });

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
        } catch {
          // ignore individual chunk fetch errors
        }
      }
      return { hasEoaOnly, hasWrongDomain };
    });

    expect(
      result.hasEoaOnly,
      "coinbasePreference must be 'eoaOnly' in compiled bundle — 'all' triggers Smart Wallet domain validation and causes Coinbase Wallet mobile to show 'no valid asset found'",
    ).toBe(true);

    expect(
      result.hasWrongDomain,
      "compiled bundle must NOT contain pay.oclawbox.com — that domain causes Coinbase Wallet SDK to reject WalletLink pairing with 'no valid asset found'",
    ).toBe(false);
  });
});

