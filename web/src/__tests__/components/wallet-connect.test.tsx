import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WalletConnect } from "@/components/wallet-connect";
import type { StatusType } from "@/components/status-message";

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

import { isEvmAvailable, connectEvm, sendEvmTransfer } from "@/lib/wallets/evm";
import { isSolanaAvailable, connectSolana, sendSolanaTransfer } from "@/lib/wallets/solana";

const defaultProps = {
  chain: "base" as const,
  token: "usdc" as const,
  tokenAddress: "0xToken",
  walletAddress: "0xWallet",
  amount: 10,
  onTxSent: vi.fn(),
  onStatus: vi.fn(),
};

describe("WalletConnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("always shows Connect MetaMask button for EVM chains", () => {
    vi.mocked(isEvmAvailable).mockReturnValue(false);
    render(<WalletConnect {...defaultProps} chain="base" />);
    expect(screen.getByText("Connect MetaMask")).toBeInTheDocument();
  });

  it("shows install prompt when MetaMask extension is not detected", () => {
    vi.mocked(isEvmAvailable).mockReturnValue(false);
    render(<WalletConnect {...defaultProps} chain="base" />);
    expect(screen.getByText(/MetaMask not detected/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Install MetaMask/i })).toHaveAttribute(
      "href",
      "https://metamask.io/download/",
    );
  });

  it("opens install page when clicking connect without extension", async () => {
    const user = userEvent.setup();
    vi.mocked(isEvmAvailable).mockReturnValue(false);
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<WalletConnect {...defaultProps} chain="base" />);
    await user.click(screen.getByText("Connect MetaMask"));

    expect(openSpy).toHaveBeenCalledWith(
      "https://metamask.io/download/",
      "_blank",
      "noopener,noreferrer",
    );
    openSpy.mockRestore();
  });

  it("does not show install prompt when MetaMask is available", () => {
    vi.mocked(isEvmAvailable).mockReturnValue(true);
    render(<WalletConnect {...defaultProps} chain="base" />);
    expect(screen.getByText("Connect MetaMask")).toBeInTheDocument();
    expect(screen.queryByText(/MetaMask not detected/i)).not.toBeInTheDocument();
  });

  it("always shows Connect Phantom button for Solana", () => {
    vi.mocked(isSolanaAvailable).mockReturnValue(false);
    render(<WalletConnect {...defaultProps} chain="sol" />);
    expect(screen.getByText("Connect Phantom")).toBeInTheDocument();
    expect(screen.getByText(/Phantom not detected/i)).toBeInTheDocument();
  });

  it("shows Connect Phantom without install prompt when Phantom is available", () => {
    vi.mocked(isSolanaAvailable).mockReturnValue(true);
    render(<WalletConnect {...defaultProps} chain="sol" />);
    expect(screen.getByText("Connect Phantom")).toBeInTheDocument();
    expect(screen.queryByText(/Phantom not detected/i)).not.toBeInTheDocument();
  });

  it("shows Connect TON Wallet button for TON chain", () => {
    render(<WalletConnect {...defaultProps} chain="ton" />);
    expect(screen.getByText("Connect TON Wallet")).toBeInTheDocument();
  });

  it("connects MetaMask and shows address on click", async () => {
    const user = userEvent.setup();
    vi.mocked(isEvmAvailable).mockReturnValue(true);
    vi.mocked(connectEvm).mockResolvedValue({
      signer: {} as any,
      address: "0x1234567890abcdef1234567890abcdef12345678",
    });

    const onStatus = vi.fn();
    render(<WalletConnect {...defaultProps} chain="base" onStatus={onStatus} />);

    await user.click(screen.getByText("Connect MetaMask"));
    expect(connectEvm).toHaveBeenCalledWith("base");
    expect(onStatus).toHaveBeenCalledWith("pending", expect.stringContaining("0x1234"));
  });

  it("shows error when EVM connection fails", async () => {
    const user = userEvent.setup();
    vi.mocked(isEvmAvailable).mockReturnValue(true);
    vi.mocked(connectEvm).mockRejectedValue(new Error("User rejected"));

    const onStatus = vi.fn();
    render(<WalletConnect {...defaultProps} chain="base" onStatus={onStatus} />);

    await user.click(screen.getByText("Connect MetaMask"));
    expect(onStatus).toHaveBeenCalledWith("error", "User rejected");
  });

  it("connects Phantom and shows address on click", async () => {
    const user = userEvent.setup();
    vi.mocked(isSolanaAvailable).mockReturnValue(true);
    vi.mocked(connectSolana).mockResolvedValue({
      publicKey: {} as any,
      address: "SoLANAAddress123456789012345678901234567890",
    });

    const onStatus = vi.fn();
    render(<WalletConnect {...defaultProps} chain="sol" onStatus={onStatus} />);

    await user.click(screen.getByText("Connect Phantom"));
    expect(connectSolana).toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith("pending", expect.stringContaining("SoLANA"));
  });

  it("disables connect button when disabled prop is true", () => {
    vi.mocked(isEvmAvailable).mockReturnValue(true);
    render(<WalletConnect {...defaultProps} chain="base" disabled />);
    expect(screen.getByText("Connect MetaMask")).toBeDisabled();
  });

  it("sends EVM payment after connecting", async () => {
    const user = userEvent.setup();
    vi.mocked(isEvmAvailable).mockReturnValue(true);
    const mockSigner = { mock: true };
    vi.mocked(connectEvm).mockResolvedValue({
      signer: mockSigner as any,
      address: "0x1234567890abcdef1234567890abcdef12345678",
    });
    vi.mocked(sendEvmTransfer).mockResolvedValue("0xTxHash123");

    const onTxSent = vi.fn();
    const onStatus = vi.fn();
    render(
      <WalletConnect
        {...defaultProps}
        chain="base"
        onTxSent={onTxSent}
        onStatus={onStatus}
      />,
    );

    // Connect
    await user.click(screen.getByText("Connect MetaMask"));

    // Send
    await user.click(screen.getByText("Pay $10.00 USDC"));
    expect(sendEvmTransfer).toHaveBeenCalledWith(mockSigner, "0xToken", "0xWallet", 10);
    expect(onTxSent).toHaveBeenCalledWith("0xTxHash123");
  });

  it("shows error when send fails", async () => {
    const user = userEvent.setup();
    vi.mocked(isEvmAvailable).mockReturnValue(true);
    vi.mocked(connectEvm).mockResolvedValue({
      signer: {} as any,
      address: "0x1234567890abcdef1234567890abcdef12345678",
    });
    vi.mocked(sendEvmTransfer).mockRejectedValue(new Error("Insufficient balance"));

    const onStatus = vi.fn();
    render(<WalletConnect {...defaultProps} chain="base" onStatus={onStatus} />);

    await user.click(screen.getByText("Connect MetaMask"));
    await user.click(screen.getByText("Pay $10.00 USDC"));
    expect(onStatus).toHaveBeenCalledWith("error", "Insufficient balance");
  });
});
