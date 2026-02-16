"use client";

import { useState } from "react";
import type { ChainId, TokenId } from "@/lib/config";
import { EVM_CHAINS } from "@/lib/config";
import { isEvmAvailable, connectEvm, sendEvmTransfer } from "@/lib/wallets/evm";
import { isSolanaAvailable, connectSolana, sendSolanaTransfer } from "@/lib/wallets/solana";
import type { StatusType } from "./status-message";
import type { Signer } from "ethers";

const INSTALL_URLS: Record<string, { name: string; url: string }> = {
  evm: { name: "EVM wallet", url: "https://metamask.io/download/" },
  sol: { name: "Phantom", url: "https://phantom.app/download" },
  ton: { name: "Tonkeeper", url: "https://tonkeeper.com/" },
};

interface WalletConnectProps {
  chain: ChainId;
  token: TokenId;
  tokenAddress: string;
  walletAddress: string;
  amount: number;
  onTxSent: (txHash: string) => void;
  disabled?: boolean;
  onStatus: (type: StatusType, message: string) => void;
}

export function WalletConnect({
  chain,
  token,
  tokenAddress,
  walletAddress,
  amount,
  onTxSent,
  disabled,
  onStatus,
}: WalletConnectProps) {
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);
  const [evmSigner, setEvmSigner] = useState<Signer | null>(null);
  const [sending, setSending] = useState(false);

  const isEvm = EVM_CHAINS.includes(chain);
  const isSol = chain === "sol";
  const isTon = chain === "ton";

  // Check extension availability
  const hasEvmWallet = isEvm && isEvmAvailable();
  const hasSolWallet = isSol && isSolanaAvailable();

  // Determine wallet type for install prompt
  const walletType = isEvm ? "evm" : isSol ? "sol" : "ton";
  const walletInfo = INSTALL_URLS[walletType];
  const hasExtension = hasEvmWallet || hasSolWallet || isTon;

  async function handleConnect() {
    // If no extension, open install page
    if (!hasExtension) {
      window.open(walletInfo.url, "_blank", "noopener,noreferrer");
      return;
    }

    try {
      if (isEvm) {
        const { signer, address } = await connectEvm(chain);
        setEvmSigner(signer);
        setConnectedAddress(address);
        onStatus("pending", `Connected: ${address.slice(0, 6)}...${address.slice(-4)}`);
      } else if (isSol) {
        const { address } = await connectSolana();
        setConnectedAddress(address);
        onStatus("pending", `Connected: ${address.slice(0, 6)}...${address.slice(-4)}`);
      }
    } catch (err) {
      onStatus("error", err instanceof Error ? err.message : "Connection failed");
    }
  }

  async function handleSend() {
    setSending(true);
    onStatus("pending", "Confirm the transaction in your wallet...");
    try {
      let txHash: string;

      if (isEvm && evmSigner) {
        txHash = await sendEvmTransfer(evmSigner, tokenAddress, walletAddress, amount);
      } else if (isSol) {
        const mintAddr = tokenAddress;
        txHash = await sendSolanaTransfer(mintAddr, walletAddress, amount);
      } else {
        throw new Error("Wallet not connected");
      }

      onTxSent(txHash);
    } catch (err) {
      onStatus("error", err instanceof Error ? err.message : "Transaction failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-3">
      {/* Connect button — always shown */}
      {!connectedAddress && (
        <>
          <button
            onClick={handleConnect}
            disabled={disabled}
            className={`
              w-full rounded-lg px-4 py-3 text-sm font-semibold
              transition-all duration-150
              ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
              ${isEvm ? "bg-[#3b82f6] hover:bg-[#2563eb] text-white" : ""}
              ${isSol ? "bg-[#ab9ff2] hover:bg-[#9b8fe2] text-black" : ""}
              ${isTon ? "bg-[#0098ea] hover:bg-[#0088d0] text-white" : ""}
            `}
          >
            {isEvm && "Connect Wallet"}
            {isSol && "Connect Phantom"}
            {isTon && "Connect TON Wallet"}
          </button>

          {/* Install prompt when extension not detected */}
          {!hasExtension && (
            <p className="text-xs text-muted text-center">
              {walletInfo.name} not detected.{" "}
              <a
                href={walletInfo.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline hover:text-accent-hover"
              >
                Install {walletInfo.name}
              </a>
            </p>
          )}
        </>
      )}

      {/* Connected state */}
      {connectedAddress && (
        <>
          <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-3 py-2">
            <div className="h-2 w-2 rounded-full bg-success" />
            <span className="text-xs font-mono text-success">
              {connectedAddress.slice(0, 6)}...{connectedAddress.slice(-4)}
            </span>
          </div>

          <button
            onClick={handleSend}
            disabled={disabled || sending}
            className={`
              w-full rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-white
              transition-all duration-150
              ${disabled || sending ? "opacity-50 cursor-not-allowed" : "hover:bg-accent-hover cursor-pointer"}
            `}
          >
            {sending ? (
              <span className="flex items-center justify-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Sending...
              </span>
            ) : (
              `Pay $${amount.toFixed(2)} ${token.toUpperCase()}`
            )}
          </button>
        </>
      )}
    </div>
  );
}
