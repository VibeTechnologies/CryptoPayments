"use client";

import type { TokenId } from "@/lib/config";

interface Token {
  id: TokenId;
  name: string;
}

interface TokenSelectorProps {
  tokens: Token[];
  selected: TokenId;
  onSelect: (token: TokenId) => void;
  disabled?: boolean;
  disabledTokens?: TokenId[];
}

export function TokenSelector({
  tokens,
  selected,
  onSelect,
  disabled,
  disabledTokens = [],
}: TokenSelectorProps) {
  return (
    <div className="flex gap-2">
      {tokens.map((token) => {
        const isDisabled = disabled || disabledTokens.includes(token.id);
        return (
          <button
            key={token.id}
            onClick={() => onSelect(token.id)}
            disabled={isDisabled}
            className={`
              flex-1 rounded-lg border px-3 py-2.5 text-sm font-semibold
              transition-all duration-150
              ${
                selected === token.id
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border bg-surface text-muted hover:border-border-active hover:text-foreground"
              }
              ${isDisabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}
            `}
          >
            {token.name}
          </button>
        );
      })}
    </div>
  );
}
