import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StatusMessage } from "@/components/status-message";

describe("StatusMessage", () => {
  it("renders pending status with hourglass icon", () => {
    render(<StatusMessage type="pending" message="Verifying..." />);
    expect(screen.getByText("Verifying...")).toBeInTheDocument();
    expect(screen.getByText("⏳")).toBeInTheDocument();
  });

  it("renders success status with checkmark icon", () => {
    render(<StatusMessage type="success" message="Payment verified!" />);
    expect(screen.getByText("Payment verified!")).toBeInTheDocument();
    expect(screen.getByText("✔")).toBeInTheDocument();
  });

  it("renders error status with X icon", () => {
    render(<StatusMessage type="error" message="Transaction failed" />);
    expect(screen.getByText("Transaction failed")).toBeInTheDocument();
    expect(screen.getByText("✘")).toBeInTheDocument();
  });

  it("applies correct styles for pending", () => {
    const { container } = render(<StatusMessage type="pending" message="waiting" />);
    const div = container.firstChild as HTMLElement;
    expect(div.className).toContain("text-warning");
  });

  it("applies correct styles for success", () => {
    const { container } = render(<StatusMessage type="success" message="done" />);
    const div = container.firstChild as HTMLElement;
    expect(div.className).toContain("text-success");
  });

  it("applies correct styles for error", () => {
    const { container } = render(<StatusMessage type="error" message="fail" />);
    const div = container.firstChild as HTMLElement;
    expect(div.className).toContain("text-error");
  });
});
