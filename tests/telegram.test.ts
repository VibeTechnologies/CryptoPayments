import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyTelegramInitData } from "../src/telegram.js";

const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";

/**
 * Build valid Telegram initData string with a proper HMAC-SHA256 hash.
 */
function buildInitData(
  params: Record<string, string>,
  botToken = BOT_TOKEN,
): string {
  // Build data check string (sorted, excluding hash)
  const entries = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const dataCheckString = entries.join("\n");

  // Compute HMAC
  const secretKey = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const hash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  // Return as URLSearchParams string
  const sp = new URLSearchParams(params);
  sp.set("hash", hash);
  return sp.toString();
}

describe("verifyTelegramInitData", () => {
  const now = Math.floor(Date.now() / 1000);
  const user = JSON.stringify({
    id: 987654321,
    first_name: "Test",
    last_name: "User",
    username: "testuser",
    language_code: "en",
  });

  it("accepts valid initData with fresh auth_date", () => {
    const initData = buildInitData({
      auth_date: String(now),
      user,
      query_id: "AAHdF6IQ",
    });

    const result = verifyTelegramInitData(initData, BOT_TOKEN);

    expect(result.valid).toBe(true);
    expect(result.user).toBeDefined();
    expect(result.user!.id).toBe(987654321);
    expect(result.user!.username).toBe("testuser");
    expect(result.authDate).toBe(now);
    expect(result.queryId).toBe("AAHdF6IQ");
  });

  it("rejects initData with wrong bot token", () => {
    const initData = buildInitData({
      auth_date: String(now),
      user,
    });

    const result = verifyTelegramInitData(initData, "wrong:token");
    expect(result.valid).toBe(false);
  });

  it("rejects initData without hash", () => {
    const sp = new URLSearchParams({
      auth_date: String(now),
      user,
    });

    const result = verifyTelegramInitData(sp.toString(), BOT_TOKEN);
    expect(result.valid).toBe(false);
  });

  it("rejects initData with tampered data", () => {
    const initData = buildInitData({
      auth_date: String(now),
      user,
    });

    // Tamper with the user field
    const tampered = initData.replace("testuser", "hacker");

    const result = verifyTelegramInitData(tampered, BOT_TOKEN);
    expect(result.valid).toBe(false);
  });

  it("rejects expired initData (> maxAgeSeconds)", () => {
    const oldDate = now - 7200; // 2 hours ago
    const initData = buildInitData({
      auth_date: String(oldDate),
      user,
    });

    const result = verifyTelegramInitData(initData, BOT_TOKEN, 3600);
    expect(result.valid).toBe(false);
  });

  it("accepts initData within custom maxAgeSeconds", () => {
    const recentDate = now - 100;
    const initData = buildInitData({
      auth_date: String(recentDate),
      user,
    });

    const result = verifyTelegramInitData(initData, BOT_TOKEN, 300);
    expect(result.valid).toBe(true);
  });

  it("handles initData without user field", () => {
    const initData = buildInitData({
      auth_date: String(now),
      query_id: "test123",
    });

    const result = verifyTelegramInitData(initData, BOT_TOKEN);
    expect(result.valid).toBe(true);
    expect(result.user).toBeUndefined();
    expect(result.queryId).toBe("test123");
  });

  it("handles start_param", () => {
    const initData = buildInitData({
      auth_date: String(now),
      user,
      start_param: "pro_123456",
    });

    const result = verifyTelegramInitData(initData, BOT_TOKEN);
    expect(result.valid).toBe(true);
    expect(result.startParam).toBe("pro_123456");
  });

  it("handles malformed user JSON gracefully", () => {
    const initData = buildInitData({
      auth_date: String(now),
      user: "not-valid-json",
    });

    const result = verifyTelegramInitData(initData, BOT_TOKEN);
    expect(result.valid).toBe(true);
    expect(result.user).toBeUndefined();
  });
});
