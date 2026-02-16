import { describe, it, expect } from "vitest";
import { buildTonTransferMessage, isTonAvailable } from "@/lib/wallets/ton";
import { Cell } from "@ton/core";

describe("TON wallet", () => {
  it("isTonAvailable returns true (QR/deep link based)", () => {
    expect(isTonAvailable()).toBe(true);
  });

  describe("buildTonTransferMessage", () => {
    const params = {
      jettonAddress: "EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA", // TON USDC
      toAddress: "EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA",
      amountUsd: 10,
    };

    it("returns a valid TonConnect transaction with validUntil", () => {
      const result = buildTonTransferMessage(params);
      expect(result.validUntil).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(result.validUntil).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 600);
    });

    it("includes one message to jetton address with 0.05 TON gas", () => {
      const result = buildTonTransferMessage(params);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].address).toBe(params.jettonAddress);
      expect(result.messages[0].amount).toBe("50000000"); // 0.05 TON
    });

    it("produces a valid base64-encoded BOC payload", () => {
      const result = buildTonTransferMessage(params);
      const payload = result.messages[0].payload;

      // Must be a non-empty base64 string
      expect(payload).toBeTruthy();
      expect(typeof payload).toBe("string");

      // Decode and parse the BOC
      const boc = Buffer.from(payload, "base64");
      const cell = Cell.fromBoc(boc)[0];
      const slice = cell.beginParse();

      // op: transfer (0x0f8a7ea5)
      expect(slice.loadUint(32)).toBe(0x0f8a7ea5);
      // query_id: 0
      expect(slice.loadUint(64)).toBe(0);
      // amount: 10 * 1e6 = 10_000_000
      expect(slice.loadCoins()).toBe(10_000_000n);
    });

    it("encodes correct amount for $25 plan", () => {
      const result = buildTonTransferMessage({ ...params, amountUsd: 25 });
      const boc = Buffer.from(result.messages[0].payload, "base64");
      const cell = Cell.fromBoc(boc)[0];
      const slice = cell.beginParse();

      slice.loadUint(32); // op
      slice.loadUint(64); // query_id
      expect(slice.loadCoins()).toBe(25_000_000n); // 25 * 1e6
    });
  });
});
