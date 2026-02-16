"use client";

import type { ChainId, TokenId } from "@/lib/config";

const CHAIN_NAMES: Record<ChainId, string> = {
  base: "Base",
  eth: "Ethereum",
  sol: "Solana",
  ton: "TON",
  base_sepolia: "Base Sepolia",
};

interface AmountDisplayProps {
  amount: number;
  token: TokenId;
  chain: ChainId;
}

export function AmountDisplay({ amount, token, chain }: AmountDisplayProps) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5 text-center">
      <div className="text-3xl font-bold tracking-tight">
        ${amount.toFixed(2)}
      </div>
      <div className="mt-1 text-sm text-muted">
        {token.toUpperCase()} on {CHAIN_NAMES[chain]}
      </div>
    </div>
  );
}
