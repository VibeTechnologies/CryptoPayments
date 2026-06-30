import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- AppKit mock (must be before any import of appkit) ----
const mockSubscribeState = vi.fn();
const mockOpen = vi.fn();
const mockGetIsConnectedState = vi.fn();
const mockGetProvider = vi.fn();
const mockCreateAppKit = vi.fn(() => ({
  subscribeState: mockSubscribeState,
  open: mockOpen,
  getIsConnectedState: mockGetIsConnectedState,
  getProvider: mockGetProvider,
}));

vi.mock("@reown/appkit", () => ({
  createAppKit: mockCreateAppKit,
}));

vi.mock("@reown/appkit-adapter-ethers", () => ({
  EthersAdapter: vi.fn(function () {}),
}));

vi.mock("@reown/appkit/networks", () => ({
  base: { id: 8453 },
  mainnet: { id: 1 },
  arbitrum: { id: 42161 },
  baseSepolia: { id: 84532 },
  sepolia: { id: 11155111 },
}));

vi.mock("ethers", () => ({
  // Must use function keyword so vi.fn() acts as constructor
  BrowserProvider: vi.fn(function (this: unknown) {
    return { getSigner: vi.fn().mockResolvedValue({ address: "0xabc" }) };
  }),
}));

// Dynamically import after mocks are set up
const { openAndWaitForConnection, getAppKitSigner } = await import(
  "@/lib/wallets/appkit"
);

// Capture createAppKit call args immediately — before vi.clearAllMocks() in later beforeEach blocks wipes them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const capturedAppKitConfig: Record<string, any> = mockCreateAppKit.mock.calls[0]?.[0] ?? {};

describe("openAndWaitForConnection()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpen.mockResolvedValue(undefined);
  });

  it("resolves when modal closes with active session", async () => {
    // subscribeState calls handler synchronously with closed+connected state
    mockSubscribeState.mockImplementation((handler) => {
      handler({ open: false });
      return vi.fn(); // unsub
    });
    mockGetIsConnectedState.mockReturnValue(true);

    await expect(openAndWaitForConnection()).resolves.toBeUndefined();
  });

  it("rejects when modal closes without a connection (user cancelled)", async () => {
    mockSubscribeState.mockImplementation((handler) => {
      handler({ open: false });
      return vi.fn();
    });
    mockGetIsConnectedState.mockReturnValue(false);

    await expect(openAndWaitForConnection()).rejects.toThrow(
      "Wallet connection cancelled",
    );
  });

  it("ignores state updates while modal is still open, resolves on close", async () => {
    let storedHandler: ((s: { open: boolean }) => void) | null = null;
    mockSubscribeState.mockImplementation((handler) => {
      storedHandler = handler;
      return vi.fn();
    });
    // modal open = true → should be ignored; then false + connected → resolves
    mockGetIsConnectedState.mockReturnValue(true);

    const promise = openAndWaitForConnection();
    storedHandler!({ open: true }); // still open — no resolution yet
    storedHandler!({ open: false }); // modal closed + connected
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects immediately if appKit.open() throws", async () => {
    mockSubscribeState.mockReturnValue(vi.fn()); // unsub no-op
    mockOpen.mockRejectedValue(new Error("Modal init failed"));

    await expect(openAndWaitForConnection()).rejects.toThrow("Modal init failed");
  });
});

describe("getAppKitSigner()", () => {
  it("throws when no provider (no active WC session)", async () => {
    mockGetProvider.mockReturnValue(null);

    await expect(getAppKitSigner()).rejects.toThrow("No WalletConnect session");
  });

  it("returns a signer when provider is present", async () => {
    const fakeProvider = {};
    mockGetProvider.mockReturnValue(fakeProvider);

    const signer = await getAppKitSigner();
    expect(signer).toEqual({ address: "0xabc" });
  });
});

// Regression: "no valid asset found" on Coinbase Wallet mobile (fix/coinbase-no-valid-asset)
// Root causes: (1) metadata.url hardcoded to wrong domain, (2) coinbasePreference:"all" triggers
// Smart Wallet validation which rejects unregistered dApps.
describe("AppKit config — Coinbase Wallet 'no valid asset found' regression", () => {
  it("uses eoaOnly coinbasePreference — bypasses Smart Wallet, uses WalletLink QR", () => {
    expect(capturedAppKitConfig.coinbasePreference).toBe("eoaOnly");
  });

  it("metadata.url does not contain hardcoded wrong domain pay.oclawbox.com", () => {
    expect(capturedAppKitConfig.metadata?.url).not.toContain("pay.oclawbox.com");
  });

  it("metadata.icons[0] does not contain hardcoded wrong domain pay.oclawbox.com", () => {
    expect(capturedAppKitConfig.metadata?.icons?.[0]).not.toContain("pay.oclawbox.com");
  });

  it("metadata.url is a valid https URL", () => {
    // Should be a valid https URL (not an empty string or undefined)
    expect(capturedAppKitConfig.metadata?.url).toMatch(/^https?:\/\//);
  });
});
