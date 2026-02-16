import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { AmountDisplay } from "@/components/amount-display";

describe("AmountDisplay", () => {
  it("renders the formatted dollar amount", () => {
    render(<AmountDisplay amount={10} token="usdc" chain="base" />);
    expect(screen.getByText("$10.00")).toBeInTheDocument();
  });

  it("shows token and chain name", () => {
    render(<AmountDisplay amount={25} token="usdt" chain="eth" />);
    expect(screen.getByText("USDT on Ethereum")).toBeInTheDocument();
  });

  it("formats fractional amounts correctly", () => {
    render(<AmountDisplay amount={99.5} token="usdc" chain="sol" />);
    expect(screen.getByText("$99.50")).toBeInTheDocument();
  });

  it("shows correct chain names for all chains", () => {
    const { rerender } = render(<AmountDisplay amount={10} token="usdc" chain="base" />);
    expect(screen.getByText("USDC on Base")).toBeInTheDocument();

    rerender(<AmountDisplay amount={10} token="usdc" chain="ton" />);
    expect(screen.getByText("USDC on TON")).toBeInTheDocument();

    rerender(<AmountDisplay amount={10} token="usdc" chain="sol" />);
    expect(screen.getByText("USDC on Solana")).toBeInTheDocument();

    rerender(<AmountDisplay amount={10} token="usdc" chain="base_sepolia" />);
    expect(screen.getByText("USDC on Base Sepolia")).toBeInTheDocument();
  });

  it("uppercases token id", () => {
    render(<AmountDisplay amount={100} token="usdt" chain="base" />);
    expect(screen.getByText("USDT on Base")).toBeInTheDocument();
  });
});
