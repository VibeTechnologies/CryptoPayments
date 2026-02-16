import { describe, it, expect, vi, beforeEach } from "vitest";
import { connectEvm, isEvmAvailable } from "@/lib/wallets/evm";

// Mock ethers.js
const mockSend = vi.fn();
const mockGetAddress = vi.fn(() => "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01");
const mockGetSigner = vi.fn(() => ({ getAddress: mockGetAddress }));

vi.mock("ethers", () => {
  const BrowserProvider = vi.fn(function (this: any) {
    this.send = mockSend;
    this.getSigner = mockGetSigner;
  });
  return {
    BrowserProvider,
    Contract: vi.fn(),
    parseUnits: vi.fn(),
  };
});

describe("isEvmAvailable", () => {
  it("returns false when window.ethereum is undefined", () => {
    (window as any).ethereum = undefined;
    expect(isEvmAvailable()).toBe(false);
  });

  it("returns true when window.ethereum exists", () => {
    (window as any).ethereum = { request: vi.fn() };
    expect(isEvmAvailable()).toBe(true);
  });
});

describe("connectEvm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).ethereum = { request: vi.fn() };
    mockSend.mockResolvedValue(undefined);
  });

  it("switches to correct chain on connect", async () => {
    const result = await connectEvm("base");
    expect(mockSend).toHaveBeenCalledWith("eth_requestAccounts", []);
    expect(mockSend).toHaveBeenCalledWith("wallet_switchEthereumChain", [{ chainId: "0x2105" }]);
    expect(result.address).toBe("0xAbCdEf0123456789AbCdEf0123456789AbCdEf01");
  });

  it("adds Base Sepolia chain when wallet returns raw 4902", async () => {
    mockSend
      .mockResolvedValueOnce(undefined) // eth_requestAccounts
      .mockRejectedValueOnce({ code: 4902 }) // wallet_switchEthereumChain
      .mockResolvedValueOnce(undefined); // wallet_addEthereumChain

    const result = await connectEvm("base_sepolia");
    expect(mockSend).toHaveBeenCalledWith("wallet_addEthereumChain", [
      expect.objectContaining({
        chainId: "0x14a34",
        chainName: "Base Sepolia",
        rpcUrls: ["https://sepolia.base.org"],
      }),
    ]);
    expect(result.address).toBe("0xAbCdEf0123456789AbCdEf0123456789AbCdEf01");
  });

  it("adds chain when ethers wraps 4902 in data.originalError", async () => {
    mockSend
      .mockResolvedValueOnce(undefined) // eth_requestAccounts
      .mockRejectedValueOnce({
        code: -32603,
        data: { originalError: { code: 4902, message: "Unrecognized chain ID" } },
      })
      .mockResolvedValueOnce(undefined); // wallet_addEthereumChain

    const result = await connectEvm("base_sepolia");
    expect(mockSend).toHaveBeenCalledWith("wallet_addEthereumChain", [
      expect.objectContaining({ chainId: "0x14a34" }),
    ]);
    expect(result.address).toBe("0xAbCdEf0123456789AbCdEf0123456789AbCdEf01");
  });

  it("adds chain when error message contains 'Unrecognized chain ID'", async () => {
    mockSend
      .mockResolvedValueOnce(undefined) // eth_requestAccounts
      .mockRejectedValueOnce(
        new Error('could not coalesce error (error={"code":-32603,"data":{"originalError":{"code":4902,"message":"Unrecognized chain ID \\"0x14a34\\""}}})')
      )
      .mockResolvedValueOnce(undefined); // wallet_addEthereumChain

    const result = await connectEvm("base_sepolia");
    expect(mockSend).toHaveBeenCalledWith("wallet_addEthereumChain", [
      expect.objectContaining({ chainId: "0x14a34" }),
    ]);
    expect(result.address).toBe("0xAbCdEf0123456789AbCdEf0123456789AbCdEf01");
  });

  it("throws user-friendly message for unknown chain without addChain params", async () => {
    mockSend
      .mockResolvedValueOnce(undefined) // eth_requestAccounts
      .mockRejectedValueOnce({ code: 4902 }); // wallet_switchEthereumChain for eth

    // eth doesn't have EVM_CHAIN_PARAMS entry, so it should throw
    await expect(connectEvm("eth")).rejects.toThrow("Please add eth network to your wallet");
  });

  it("re-throws non-4902 errors", async () => {
    const otherErr = new Error("User rejected request");
    mockSend
      .mockResolvedValueOnce(undefined) // eth_requestAccounts
      .mockRejectedValueOnce(otherErr); // wallet_switchEthereumChain

    await expect(connectEvm("base")).rejects.toBe(otherErr);
  });

  it("throws when no ethereum provider", async () => {
    (window as any).ethereum = undefined;
    await expect(connectEvm("base")).rejects.toThrow("No EVM wallet detected");
  });
});
