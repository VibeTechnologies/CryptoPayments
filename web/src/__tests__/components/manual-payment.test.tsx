import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ManualPayment } from "@/components/manual-payment";

const defaultProps = {
  walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
  txHash: "",
  onTxHashChange: vi.fn(),
  onSubmit: vi.fn(),
};

describe("ManualPayment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the wallet address", () => {
    render(<ManualPayment {...defaultProps} />);
    expect(screen.getByText(defaultProps.walletAddress)).toBeInTheDocument();
  });

  it("shows 'Loading...' when no wallet address", () => {
    render(<ManualPayment {...defaultProps} walletAddress="" />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("copies wallet address to clipboard on click", async () => {
    const user = userEvent.setup();
    const writeTextSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<ManualPayment {...defaultProps} />);

    await user.click(screen.getByText(defaultProps.walletAddress));
    expect(writeTextSpy).toHaveBeenCalledWith(defaultProps.walletAddress);

    await waitFor(() => {
      expect(screen.getByText("Copied!")).toBeInTheDocument();
    });
  });

  it("renders transaction hash input", () => {
    render(<ManualPayment {...defaultProps} />);
    expect(screen.getByPlaceholderText("0x... or transaction signature")).toBeInTheDocument();
  });

  it("calls onTxHashChange when typing in input", async () => {
    const user = userEvent.setup();
    const onTxHashChange = vi.fn();
    render(<ManualPayment {...defaultProps} onTxHashChange={onTxHashChange} />);

    const input = screen.getByPlaceholderText("0x... or transaction signature");
    await user.type(input, "0xabc");
    // user-event fires change per character
    expect(onTxHashChange).toHaveBeenCalled();
  });

  it("renders Verify Payment button", () => {
    render(<ManualPayment {...defaultProps} />);
    expect(screen.getByText("Verify Payment")).toBeInTheDocument();
  });

  it("disables Verify button when txHash is empty", () => {
    render(<ManualPayment {...defaultProps} txHash="" />);
    expect(screen.getByText("Verify Payment")).toBeDisabled();
  });

  it("enables Verify button when txHash has content", () => {
    render(<ManualPayment {...defaultProps} txHash="0xabc123" />);
    expect(screen.getByText("Verify Payment")).not.toBeDisabled();
  });

  it("calls onSubmit when Verify button is clicked", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ManualPayment {...defaultProps} txHash="0xabc123" onSubmit={onSubmit} />);

    await user.click(screen.getByText("Verify Payment"));
    expect(onSubmit).toHaveBeenCalled();
  });

  it("shows 'Verifying...' when submitting", () => {
    render(<ManualPayment {...defaultProps} txHash="0xabc123" submitting />);
    expect(screen.getByText("Verifying...")).toBeInTheDocument();
  });

  it("disables all inputs when disabled", () => {
    render(<ManualPayment {...defaultProps} txHash="0xabc" disabled />);
    const input = screen.getByPlaceholderText("0x... or transaction signature");
    expect(input).toBeDisabled();
  });

  it("shows label texts", () => {
    render(<ManualPayment {...defaultProps} />);
    expect(screen.getByText("Send to this address")).toBeInTheDocument();
    expect(screen.getByText("Transaction hash")).toBeInTheDocument();
  });
});
