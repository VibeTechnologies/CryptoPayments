import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock API module
vi.mock("@/lib/api", () => ({
  fetchConfig: vi.fn(),
  submitPayment: vi.fn(),
}));

// Mock wallet modules
vi.mock("@/lib/wallets/evm", () => ({
  isEvmAvailable: vi.fn(() => false),
  connectEvm: vi.fn(),
  sendEvmTransfer: vi.fn(),
}));

vi.mock("@/lib/wallets/solana", () => ({
  isSolanaAvailable: vi.fn(() => false),
  connectSolana: vi.fn(),
  sendSolanaTransfer: vi.fn(),
}));

vi.mock("@/lib/wallets/ton", () => ({
  buildTonTransferMessage: vi.fn(),
}));

vi.mock("@tonconnect/ui-react", () => ({
  useTonConnectUI: () => [{ openModal: vi.fn(), sendTransaction: vi.fn() }, vi.fn()],
  useTonAddress: () => "",
  TonConnectUIProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock WalletConnect so tests can trigger the tx-sent callback directly,
// exercising PayPage's submit wiring without driving a real wallet.
// The mock records its props so tests can assert the page disables payment.
const walletConnectProps: Array<{ disabled?: boolean }> = [];
function lastWalletConnectProps() {
  return walletConnectProps[walletConnectProps.length - 1];
}
vi.mock("@/components/wallet-connect", () => ({
  WalletConnect: (props: { onTxSent: (hash: string) => void; disabled?: boolean }) => {
    walletConnectProps.push(props);
    return (
      <button data-testid="mock-tx-sent" onClick={() => props.onTxSent("0xdeadbeef")}>
        mock send
      </button>
    );
  },
}));

import { fetchConfig, submitPayment } from "@/lib/api";
import PayPage from "@/app/pay/page";
import { INTENT_PARAM_KEYS, INTENT_PARAM_TO_BODY_FIELD, canonicalIntentString } from "@/lib/intent";

const mockConfig = {
  wallets: {
    base: "0xBaseWallet",
    eth: "0xEthWallet",
    sol: "SolWallet123",
    ton: "TONWallet456",
    base_sepolia: "0xSepoliaWallet",
    eth_sepolia: "0xEthSepoliaWallet",
  },
  prices: { starter: 10, pro: 25, max: 100 },
  tokens: {
    base: { usdc: "0xBaseUSDC", usdt: "0xBaseUSDT" },
    eth: { usdc: "0xEthUSDC", usdt: "0xEthUSDT" },
    sol: { usdc: "SolUSDC", usdt: "SolUSDT" },
    ton: { usdc: "TonUSDC", usdt: "TonUSDT" },
    base_sepolia: { usdc: "0xSepoliaUSDC", usdt: "0x" },
    eth_sepolia: { usdc: "0x", usdt: "0x", ausd: "0xEthSepoliaAUSD" },
  },
  chains: ["base", "eth", "sol", "ton", "base_sepolia", "eth_sepolia"],
};

function setUrlParams(params: Record<string, string>) {
  const url = new URL("http://localhost/pay");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  Object.defineProperty(window, "location", {
    value: { ...window.location, search: url.search, href: url.href },
    writable: true,
    configurable: true,
  });
}

describe("PayPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    walletConnectProps.length = 0;
    // Default: user identified via URL params
    setUrlParams({ uid: "12345", plan: "starter", idtype: "tg" });
    vi.mocked(fetchConfig).mockResolvedValue(mockConfig as any);
    // Ensure Telegram is undefined
    (window as any).Telegram = undefined;
  });

  it("shows loading spinner initially", () => {
    // Make fetchConfig hang
    vi.mocked(fetchConfig).mockReturnValue(new Promise(() => {}));
    render(<PayPage />);
    // Spinner has animate-spin class — just check no main content yet
    expect(screen.queryByText("Pay with Crypto")).not.toBeInTheDocument();
  });

  it("renders main payment UI after config loads", async () => {
    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("Pay with Crypto")).toBeInTheDocument();
    });
    expect(screen.getByText(/User 12345/)).toBeInTheDocument();
    expect(screen.getByText(/Starter plan/)).toBeInTheDocument();
  });

  it("shows error message when config fails to load", async () => {
    vi.mocked(fetchConfig).mockRejectedValue(new Error("Network error"));
    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("Failed to load payment configuration")).toBeInTheDocument();
    });
  });

  it("shows 'No user identified' when uid is missing", async () => {
    setUrlParams({});
    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("No user identified")).toBeInTheDocument();
    });
  });

  it("displays correct amount for selected plan", async () => {
    setUrlParams({ uid: "12345", plan: "pro" });
    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("$25.00")).toBeInTheDocument();
    });
  });

  it("renders all 3 steps", async () => {
    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("Select network")).toBeInTheDocument();
    });
    expect(screen.getByText("Select token")).toBeInTheDocument();
    expect(screen.getByText("Send payment")).toBeInTheDocument();
  });

  it("renders chain selector with mainnet chains (hides testnet by default)", async () => {
    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("Base")).toBeInTheDocument();
    });
    expect(screen.getByText("Ethereum")).toBeInTheDocument();
    expect(screen.getByText("Solana")).toBeInTheDocument();
    expect(screen.getByText("TON")).toBeInTheDocument();
    // Base Sepolia should be hidden by default
    expect(screen.queryByText("Base Sepolia")).not.toBeInTheDocument();
  });

  it("shows testnet chains when ?test=true is set", async () => {
    setUrlParams({ uid: "12345", plan: "starter", idtype: "tg", test: "true" });
    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("Base")).toBeInTheDocument();
    });
    expect(screen.getByText("Base Sepolia")).toBeInTheDocument();
    expect(screen.getByText("Ethereum Sepolia")).toBeInTheDocument();
  });

  it("renders token selector with USDC, USDT and aUSD", async () => {
    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("USDC")).toBeInTheDocument();
    });
    expect(screen.getByText("USDT")).toBeInTheDocument();
    expect(screen.getByText("aUSD")).toBeInTheDocument();
  });

  it("updates amount display when changing chain", async () => {
    const user = userEvent.setup();
    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("USDC on Base")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Ethereum"));
    expect(screen.getByText("USDC on Ethereum")).toBeInTheDocument();
  });

  it("updates amount display when changing token", async () => {
    const user = userEvent.setup();
    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("USDC on Base")).toBeInTheDocument();
    });

    await user.click(screen.getByText("USDT"));
    expect(screen.getByText("USDT on Base")).toBeInTheDocument();
  });

  it("shows footer", async () => {
    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("Powered by OpenClaw")).toBeInTheDocument();
    });
  });

  it("parses Telegram start_param for plan and uid", async () => {
    setUrlParams({});
    (window as any).Telegram = {
      WebApp: {
        ready: vi.fn(),
        expand: vi.fn(),
        close: vi.fn(),
        initData: "test_init_data",
        initDataUnsafe: {
          user: { id: 99999, first_name: "Alice" },
          start_param: "pro_99999",
        },
      },
    };

    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("$25.00")).toBeInTheDocument();
    });
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
    expect(screen.getByText(/Pro plan/)).toBeInTheDocument();
  });
  // Regression (OpenClawBot#3583): the signed checkout intent covers
  // `deploymentType`. If the SPA drops it from the POST body, the server
  // rebuilds the legacy canonical string, the HMAC diverges and the request
  // 401s AFTER the buyer's transfer is already mined. Money taken, nothing
  // provisioned. So the SPA must forward it verbatim from the query string.
  it("forwards signed deploymentType from the URL into the payment request", async () => {
    const user = userEvent.setup();
    setUrlParams({
      uid: "12345",
      plan: "max",
      idtype: "tg",
      deploymentType: "hermes",
      amountUsd: "100.00",
      exp: "9999999999",
      sig: "abc123",
    });
    vi.mocked(submitPayment).mockResolvedValue({ payment: { status: "verified", id: "p1" } } as any);

    render(<PayPage />);
    await waitFor(() => expect(screen.getByTestId("mock-tx-sent")).toBeInTheDocument());
    await user.click(screen.getByTestId("mock-tx-sent"));

    await waitFor(() => expect(submitPayment).toHaveBeenCalled());
    expect(vi.mocked(submitPayment).mock.calls[0][0]).toMatchObject({
      deploymentType: "hermes",
      exp: "9999999999",
      sig: "abc123",
    });
  });

  // Class guard: the page must forward EVERY signed intent key verbatim. The
  // old per-field whitelist dropped vmp=lxd (AgentPod) and 401'd post-payment.
  it("forwards every signed intent param verbatim (vmp=lxd, unknown hostType, ...)", async () => {
    const user = userEvent.setup();
    const intent: Record<string, string> = {
      plan: "max",
      uid: "12345",
      idtype: "tg",
      amountUsd: "105.00",
      exp: "9999999999",
      callback: "https://cb.example/hook?a=1&b=2",
      tenantType: "Team Ünicode",
      tenant: "Team Ünicode",
      vmp: "lxd",
      hostType: "bare-metal",
      deploymentType: "hermes",
    };
    setUrlParams({ ...intent, sig: "abc123" });
    vi.mocked(submitPayment).mockResolvedValue({ payment: { status: "verified", id: "p1" } } as unknown as Awaited<ReturnType<typeof submitPayment>>);

    render(<PayPage />);
    await waitFor(() => expect(screen.getByTestId("mock-tx-sent")).toBeInTheDocument());
    await user.click(screen.getByTestId("mock-tx-sent"));

    await waitFor(() => expect(submitPayment).toHaveBeenCalled());
    const sent = vi.mocked(submitPayment).mock.calls[0][0] as unknown as Record<string, string>;
    for (const key of INTENT_PARAM_KEYS) {
      if (key === "topup") continue; // not in this URL
      expect(sent[INTENT_PARAM_TO_BODY_FIELD[key]], key).toBe(intent[key]);
    }
    expect(sent.sig).toBe("abc123");
    const urlCanonical = Object.entries(intent)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    expect(canonicalIntentString(sent)).toBe(urlCanonical);
  });

  function mockTelegramUser() {
    window.Telegram = {
      WebApp: {
        ready: vi.fn(),
        expand: vi.fn(),
        close: vi.fn(),
        initData: "signed_tg_init_data",
        initDataUnsafe: { user: { id: 12345, first_name: "Alice" } },
      },
    };
  }

  const INVALID_LINK = "This payment link is invalid or was modified. Request a new link.";

  // A signed idtype=email must not be laundered into "tg" by Telegram
  // initData; the page must fail closed BEFORE the on-chain transfer.
  it("blocks a signed idtype=email link inside Telegram (no POST)", async () => {
    const user = userEvent.setup();
    setUrlParams({ uid: "12345", plan: "max", idtype: "email", amountUsd: "100.00", exp: "9999999999", sig: "abc123" });
    mockTelegramUser();

    render(<PayPage />);
    await waitFor(() => expect(screen.getByText(INVALID_LINK)).toBeInTheDocument());
    expect(lastWalletConnectProps().disabled).toBe(true);
    await user.click(screen.getByTestId("mock-tx-sent"));
    expect(submitPayment).not.toHaveBeenCalled();
  });

  it("blocks a signed link carrying an empty signed key (vmp=) (no POST)", async () => {
    const user = userEvent.setup();
    setUrlParams({ uid: "12345", plan: "max", idtype: "tg", vmp: "", amountUsd: "100.00", exp: "9999999999", sig: "abc123" });

    render(<PayPage />);
    await waitFor(() => expect(screen.getByText(INVALID_LINK)).toBeInTheDocument());
    expect(lastWalletConnectProps().disabled).toBe(true);
    await user.click(screen.getByTestId("mock-tx-sent"));
    expect(submitPayment).not.toHaveBeenCalled();
  });

  it("sends signed idType tg and vmProvider lxd verbatim inside Telegram", async () => {
    const user = userEvent.setup();
    setUrlParams({ uid: "12345", plan: "max", idtype: "tg", vmp: "lxd", amountUsd: "105.00", exp: "9999999999", sig: "abc123" });
    mockTelegramUser();
    vi.mocked(submitPayment).mockResolvedValue({ payment: { status: "verified", id: "p1" } } as unknown as Awaited<ReturnType<typeof submitPayment>>);

    render(<PayPage />);
    await waitFor(() => expect(screen.getByTestId("mock-tx-sent")).toBeInTheDocument());
    expect(screen.queryByText(INVALID_LINK)).not.toBeInTheDocument();
    expect(lastWalletConnectProps().disabled).toBe(false);
    await user.click(screen.getByTestId("mock-tx-sent"));

    await waitFor(() => expect(submitPayment).toHaveBeenCalledTimes(1));
    expect(vi.mocked(submitPayment).mock.calls[0][0]).toMatchObject({
      idType: "tg",
      vmProvider: "lxd",
      uid: "12345",
      sig: "abc123",
      initData: "signed_tg_init_data",
    });
  });

  it("unsigned link forwards no placement/runtime fields", async () => {
    const user = userEvent.setup();
    setUrlParams({
      uid: "12345",
      plan: "max",
      idtype: "tg",
      tenantType: "team",
      tenant: "team",
      vmp: "lxd",
      hostType: "vps",
      deploymentType: "hermes",
    });
    vi.mocked(submitPayment).mockResolvedValue({ payment: { status: "verified", id: "p1" } } as any);

    render(<PayPage />);
    await waitFor(() => expect(screen.getByTestId("mock-tx-sent")).toBeInTheDocument());
    await user.click(screen.getByTestId("mock-tx-sent"));

    await waitFor(() => expect(submitPayment).toHaveBeenCalled());
    const sent = vi.mocked(submitPayment).mock.calls[0][0] as unknown as Record<string, unknown>;
    for (const field of ["tenantType", "vmProvider", "hostType", "deploymentType", "sig"]) {
      expect(sent, field).not.toHaveProperty(field);
    }
  });

  it("omits deploymentType when the intent does not carry one (legacy openclaw)", async () => {
    const user = userEvent.setup();
    setUrlParams({ uid: "12345", plan: "max", idtype: "tg" });
    vi.mocked(submitPayment).mockResolvedValue({ payment: { status: "verified", id: "p1" } } as any);

    render(<PayPage />);
    await waitFor(() => expect(screen.getByTestId("mock-tx-sent")).toBeInTheDocument());
    await user.click(screen.getByTestId("mock-tx-sent"));

    await waitFor(() => expect(submitPayment).toHaveBeenCalled());
    expect(vi.mocked(submitPayment).mock.calls[0][0].deploymentType).toBeUndefined();
  });
});
