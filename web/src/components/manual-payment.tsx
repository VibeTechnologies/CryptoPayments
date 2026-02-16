"use client";

import { useState } from "react";

interface ManualPaymentProps {
  walletAddress: string;
  txHash: string;
  onTxHashChange: (hash: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  submitting?: boolean;
}

export function ManualPayment({
  walletAddress,
  txHash,
  onTxHashChange,
  onSubmit,
  disabled,
  submitting,
}: ManualPaymentProps) {
  const [copied, setCopied] = useState(false);

  function copyAddress() {
    if (!walletAddress) return;
    navigator.clipboard.writeText(walletAddress).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="space-y-3">
      {/* Wallet address to send to */}
      <div>
        <label className="mb-1 block text-xs text-muted">
          Send to this address
        </label>
        <button
          onClick={copyAddress}
          className="w-full cursor-pointer rounded-lg border border-border bg-background px-3 py-2.5 text-left font-mono text-xs text-accent break-all transition-colors hover:border-accent/50"
        >
          {walletAddress || "Loading..."}
        </button>
        <p className="mt-1 text-right text-[10px] text-muted">
          {copied ? "Copied!" : "Tap to copy"}
        </p>
      </div>

      {/* TX hash input */}
      <div>
        <label className="mb-1 block text-xs text-muted">
          Transaction hash
        </label>
        <input
          type="text"
          value={txHash}
          onChange={(e) => onTxHashChange(e.target.value)}
          placeholder="0x... or transaction signature"
          disabled={disabled}
          className={`
            w-full rounded-lg border border-border bg-background px-3 py-2.5
            font-mono text-sm text-foreground placeholder:text-muted/50
            outline-none transition-colors focus:border-accent
            ${disabled ? "opacity-50 cursor-not-allowed" : ""}
          `}
        />
      </div>

      {/* Verify button */}
      <button
        onClick={onSubmit}
        disabled={disabled || !txHash.trim()}
        className={`
          w-full rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-white
          transition-all duration-150
          ${disabled || !txHash.trim() ? "opacity-50 cursor-not-allowed" : "hover:bg-accent-hover cursor-pointer"}
        `}
      >
        {submitting ? (
          <span className="flex items-center justify-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            Verifying...
          </span>
        ) : (
          "Verify Payment"
        )}
      </button>
    </div>
  );
}
