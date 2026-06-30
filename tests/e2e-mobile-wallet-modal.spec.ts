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
 *   BASE_URL — deployed URL (Vercel preview or pay.oclawbox.com)
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

  test("Coinbase Wallet and Rabby appear in featured wallet list", async ({ page }) => {
    await page.goto("/pay?plan=starter&uid=123456&idtype=tg&test=true");
    await page.waitForSelector('button:has-text("Connect Mobile Wallet")', { timeout: 10_000 });
    await page.locator('button:has-text("Connect Mobile Wallet")').click();

    // Modal must be in DOM
    await page.locator("appkit-modal, wui-modal, w3m-modal").first().waitFor({
      state: "attached",
      timeout: 8_000,
    });

    // AppKit fetches wallet metadata from WalletConnect explorer (network call).
    // Give it generous time in CI. Playwright's text locator pierces shadow DOM.
    // Increase timeout to 20s to allow explorer API round-trip in CI.
    await expect(page.locator("text=/Coinbase/i").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("text=/Rabby/i").first()).toBeVisible({ timeout: 20_000 });
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
});
