import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { ChainSelector } from "@/components/chain-selector";
import type { ChainId } from "@/lib/config";

const chains = [
  { id: "base" as ChainId, name: "Base", icon: "🔵" },
  { id: "eth" as ChainId, name: "Ethereum", icon: "⟠" },
  { id: "base_sepolia" as ChainId, name: "Base Sepolia", icon: "🧪", testnet: true },
];

describe("ChainSelector", () => {
  it("renders all chain buttons", () => {
    render(<ChainSelector chains={chains} selected="base" onSelect={() => {}} />);
    expect(screen.getByText("Base")).toBeInTheDocument();
    expect(screen.getByText("Ethereum")).toBeInTheDocument();
    expect(screen.getByText("Base Sepolia")).toBeInTheDocument();
  });

  it("shows TEST badge for testnet chains", () => {
    render(<ChainSelector chains={chains} selected="base" onSelect={() => {}} />);
    expect(screen.getByText("TEST")).toBeInTheDocument();
  });

  it("calls onSelect with correct chain id when clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ChainSelector chains={chains} selected="base" onSelect={onSelect} />);

    await user.click(screen.getByText("Ethereum"));
    expect(onSelect).toHaveBeenCalledWith("eth");
  });

  it("highlights the selected chain", () => {
    render(<ChainSelector chains={chains} selected="eth" onSelect={() => {}} />);
    const ethButton = screen.getByText("Ethereum").closest("button")!;
    expect(ethButton.className).toContain("border-accent");
  });

  it("disables all buttons when disabled prop is true", () => {
    render(<ChainSelector chains={chains} selected="base" onSelect={() => {}} disabled />);
    const buttons = screen.getAllByRole("button");
    for (const btn of buttons) {
      expect(btn).toBeDisabled();
    }
  });

  it("does not call onSelect when disabled", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ChainSelector chains={chains} selected="base" onSelect={onSelect} disabled />);

    await user.click(screen.getByText("Ethereum"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders chain icons", () => {
    render(<ChainSelector chains={chains} selected="base" onSelect={() => {}} />);
    expect(screen.getByText("🔵")).toBeInTheDocument();
    expect(screen.getByText("⟠")).toBeInTheDocument();
    expect(screen.getByText("🧪")).toBeInTheDocument();
  });
});
