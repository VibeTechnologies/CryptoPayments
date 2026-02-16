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

import { fetchConfig, submitPayment } from "@/lib/api";
import PayPage from "@/app/pay/page";

const mockConfig = {
  wallets: {
    base: "0xBaseWallet",
    eth: "0xEthWallet",
    sol: "SolWallet123",
    ton: "TONWallet456",
    base_sepolia: "0xSepoliaWallet",
  },
  prices: { starter: 10, pro: 25, max: 100 },
  tokens: {
    base: { usdc: "0xBaseUSDC", usdt: "0xBaseUSDT" },
    eth: { usdc: "0xEthUSDC", usdt: "0xEthUSDT" },
    sol: { usdc: "SolUSDC", usdt: "SolUSDT" },
    ton: { usdc: "TonUSDC", usdt: "TonUSDT" },
    base_sepolia: { usdc: "0xSepoliaUSDC", usdt: "0x" },
  },
  chains: ["base", "eth", "sol", "ton", "base_sepolia"],
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

  it("renders chain selector with all chains", async () => {
    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("Base")).toBeInTheDocument();
    });
    expect(screen.getByText("Ethereum")).toBeInTheDocument();
    expect(screen.getByText("Solana")).toBeInTheDocument();
    expect(screen.getByText("TON")).toBeInTheDocument();
  });

  it("renders token selector with USDC and USDT", async () => {
    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("USDC")).toBeInTheDocument();
    });
    expect(screen.getByText("USDT")).toBeInTheDocument();
  });

  it("shows 'or pay manually' divider", async () => {
    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("or pay manually")).toBeInTheDocument();
    });
  });

  it("shows wallet address in manual payment section", async () => {
    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("0xBaseWallet")).toBeInTheDocument();
    });
  });

  it("switches wallet address when changing chain", async () => {
    const user = userEvent.setup();
    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("0xBaseWallet")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Ethereum"));
    expect(screen.getByText("0xEthWallet")).toBeInTheDocument();
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

  it("submits payment with manual tx hash", async () => {
    const user = userEvent.setup();
    vi.mocked(submitPayment).mockResolvedValue({
      payment: {
        id: "pay_1",
        status: "verified",
        amount_usd: 10,
        token: "usdc",
        chain_id: "base",
        plan_id: "starter",
        tx_hash: "0xValidTxHash",
      },
    });

    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("Pay with Crypto")).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText("0x... or transaction signature");
    await user.type(input, "0xValidTxHash");
    await user.click(screen.getByText("Verify Payment"));

    await waitFor(() => {
      expect(submitPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          txHash: "0xValidTxHash",
          chainId: "base",
          token: "usdc",
          idType: "tg",
          uid: "12345",
          plan: "starter",
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/Payment verified/)).toBeInTheDocument();
    });
  });

  it("shows error when verification fails", async () => {
    const user = userEvent.setup();
    vi.mocked(submitPayment).mockResolvedValue({
      payment: {
        id: "pay_1",
        status: "failed",
        amount_usd: 0,
        token: "usdc",
        chain_id: "base",
        tx_hash: "0xBadTx",
      },
      error: "Transaction not found on chain",
    });

    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("Pay with Crypto")).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText("0x... or transaction signature");
    await user.type(input, "0xBadTx");
    await user.click(screen.getByText("Verify Payment"));

    await waitFor(() => {
      expect(screen.getByText("Transaction not found on chain")).toBeInTheDocument();
    });
  });

  it("shows duplicate error on 409", async () => {
    const user = userEvent.setup();
    vi.mocked(submitPayment).mockRejectedValue(
      new Error("This transaction was already submitted."),
    );

    render(<PayPage />);
    await waitFor(() => {
      expect(screen.getByText("Pay with Crypto")).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText("0x... or transaction signature");
    await user.type(input, "0xDupe");
    await user.click(screen.getByText("Verify Payment"));

    await waitFor(() => {
      expect(
        screen.getByText("This transaction was already submitted."),
      ).toBeInTheDocument();
    });
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
});
