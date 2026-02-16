"use client";

import type { ChainId } from "@/lib/config";

interface Chain {
  id: ChainId;
  name: string;
  icon: string;
  testnet?: boolean;
}

interface ChainSelectorProps {
  chains: Chain[];
  selected: ChainId;
  onSelect: (chain: ChainId) => void;
  disabled?: boolean;
}

export function ChainSelector({ chains, selected, onSelect, disabled }: ChainSelectorProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {chains.map((chain) => (
        <button
          key={chain.id}
          onClick={() => onSelect(chain.id)}
          disabled={disabled}
          className={`
            flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium
            transition-all duration-150
            ${
              selected === chain.id
                ? "border-accent bg-accent/10 text-accent"
                : "border-border bg-surface text-muted hover:border-border-active hover:text-foreground"
            }
            ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
          `}
        >
          <span className="text-base">{chain.icon}</span>
          <span>{chain.name}</span>
          {chain.testnet && (
            <span className="ml-0.5 rounded bg-warning/20 px-1 py-px text-[10px] font-semibold text-warning">
              TEST
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
