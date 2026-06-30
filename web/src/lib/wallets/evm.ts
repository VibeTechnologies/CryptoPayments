// EVM wallet integration via ethers.js v6 (works with any EIP-1193 wallet)

import { BrowserProvider, Contract, parseUnits, type Signer } from "ethers";
import { ERC20_ABI, EVM_CHAIN_IDS, EVM_CHAIN_PARAMS, type ChainId } from "../config";

// @reown/appkit augments Window.ethereum as Record<string,unknown>; match that
// to avoid a TS "Subsequent property declarations" conflict. We cast at point of use.
type EthereumProvider = {
  isMetaMask?: boolean;
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};
function getEthereum(): EthereumProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { ethereum?: EthereumProvider }).ethereum;
}

export function isEvmAvailable(): boolean {
  return typeof window !== "undefined" && !!getEthereum();
}

/** Check if a wallet error is "chain not recognized" (code 4902).
 *  ethers.js v6 wraps the raw provider error in UNKNOWN_ERROR,
 *  so we also check data.originalError.code. */
function isChainNotAddedError(err: unknown): boolean {
  const e = err as { code?: number; data?: { originalError?: { code?: number } } };
  if (e.code === 4902) return true;
  if (e.data?.originalError?.code === 4902) return true;
  // Also match the error message as a last resort
  if (err instanceof Error && err.message.includes("Unrecognized chain ID")) return true;
  return false;
}

export async function connectEvm(chainId: ChainId): Promise<{ signer: Signer; address: string }> {
  const eth = getEthereum();
  if (!eth) throw new Error("No EVM wallet detected");

  const provider = new BrowserProvider(eth as Parameters<typeof BrowserProvider>[0]);
  await provider.send("eth_requestAccounts", []);

  // Switch to correct chain
  const targetChainId = EVM_CHAIN_IDS[chainId];
  if (targetChainId) {
    try {
      await provider.send("wallet_switchEthereumChain", [{ chainId: targetChainId }]);
    } catch (err: unknown) {
      if (isChainNotAddedError(err)) {
        // Try to add the chain if we have params for it
        const chainParams = EVM_CHAIN_PARAMS[chainId];
        if (chainParams) {
          await provider.send("wallet_addEthereumChain", [chainParams]);
        } else {
          throw new Error(`Please add ${chainId} network to your wallet`);
        }
      } else {
        throw err;
      }
    }
  }

  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  return { signer, address };
}

/**
 * Connect an EVM wallet via WalletConnect v2 QR code (AppKit modal).
 * Works with Coinbase Wallet mobile (WalletLink) and Rabby mobile (WC v2).
 * On desktop: shows QR code + wallet list modal.
 * On mobile: shows deep links into installed wallet apps.
 */
export async function connectEvmMobile(
  chainId: ChainId,
): Promise<{ signer: Signer; address: string }> {
  const { openAndWaitForConnection, getAppKitSigner } = await import("./appkit");

  // openAndWaitForConnection subscribes to state BEFORE opening the modal,
  // then resolves when the modal closes with a connected session, or rejects
  // with "Wallet connection cancelled" if the user dismisses without connecting.
  await openAndWaitForConnection();

  const signer = await getAppKitSigner();
  const address = await signer.getAddress();

  // Request chain switch via the WalletConnect session
  const targetChainId = EVM_CHAIN_IDS[chainId];
  if (targetChainId) {
    try {
      const ethersProvider = signer.provider as import("ethers").BrowserProvider;
      await ethersProvider.send("wallet_switchEthereumChain", [{ chainId: targetChainId }]);
    } catch (err: unknown) {
      if (isChainNotAddedError(err)) {
        const chainParams = EVM_CHAIN_PARAMS[chainId];
        if (chainParams) {
          const ethersProvider = signer.provider as import("ethers").BrowserProvider;
          await ethersProvider.send("wallet_addEthereumChain", [chainParams]);
        }
      } else {
        throw err; // rethrow user rejection (4001) and other non-4902 errors
      }
    }
  }

  return { signer, address };
}

export async function sendEvmTransfer(
  signer: Signer,
  tokenAddress: string,
  toAddress: string,
  amountUsd: number,
): Promise<string> {
  if (tokenAddress === "0x" || !tokenAddress) {
    throw new Error("Token not available on this chain");
  }

  const amount = parseUnits(amountUsd.toString(), 6); // USDC/USDT = 6 decimals
  const contract = new Contract(tokenAddress, ERC20_ABI, signer);
  const tx = await contract.transfer(toAddress, amount);
  return tx.hash;
}
