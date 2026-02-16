import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { TokenSelector } from "@/components/token-selector";
import type { TokenId } from "@/lib/config";

const tokens = [
  { id: "usdc" as TokenId, name: "USDC" },
  { id: "usdt" as TokenId, name: "USDT" },
];

describe("TokenSelector", () => {
  it("renders all token buttons", () => {
    render(<TokenSelector tokens={tokens} selected="usdc" onSelect={() => {}} />);
    expect(screen.getByText("USDC")).toBeInTheDocument();
    expect(screen.getByText("USDT")).toBeInTheDocument();
  });

  it("calls onSelect with correct token id when clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<TokenSelector tokens={tokens} selected="usdc" onSelect={onSelect} />);

    await user.click(screen.getByText("USDT"));
    expect(onSelect).toHaveBeenCalledWith("usdt");
  });

  it("highlights the selected token", () => {
    render(<TokenSelector tokens={tokens} selected="usdt" onSelect={() => {}} />);
    const usdtButton = screen.getByText("USDT").closest("button")!;
    expect(usdtButton.className).toContain("border-accent");
  });

  it("disables all buttons when disabled prop is true", () => {
    render(<TokenSelector tokens={tokens} selected="usdc" onSelect={() => {}} disabled />);
    const buttons = screen.getAllByRole("button");
    for (const btn of buttons) {
      expect(btn).toBeDisabled();
    }
  });

  it("disables specific tokens via disabledTokens", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <TokenSelector
        tokens={tokens}
        selected="usdc"
        onSelect={onSelect}
        disabledTokens={["usdt"]}
      />,
    );

    const usdtButton = screen.getByText("USDT").closest("button")!;
    expect(usdtButton).toBeDisabled();

    await user.click(usdtButton);
    expect(onSelect).not.toHaveBeenCalled();

    // USDC should still work
    await user.click(screen.getByText("USDC"));
    expect(onSelect).toHaveBeenCalledWith("usdc");
  });

  it("defaults disabledTokens to empty array", () => {
    render(<TokenSelector tokens={tokens} selected="usdc" onSelect={() => {}} />);
    const buttons = screen.getAllByRole("button");
    for (const btn of buttons) {
      expect(btn).not.toBeDisabled();
    }
  });
});
