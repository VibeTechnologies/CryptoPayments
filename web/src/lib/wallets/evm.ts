// EVM wallet integration via ethers.js v6 (works with any EIP-1193 wallet)

import { BrowserProvider, Contract, parseUnits, type Signer } from "ethers";
import { ERC20_ABI, EVM_CHAIN_IDS, type ChainId } from "../config";

declare global {
  interface Window {
    ethereum?: {
      isMetaMask?: boolean;
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

export function isEvmAvailable(): boolean {
  return typeof window !== "undefined" && !!window.ethereum;
}

export async function connectEvm(chainId: ChainId): Promise<{ signer: Signer; address: string }> {
  if (!window.ethereum) throw new Error("No EVM wallet detected");

  const provider = new BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);

  // Switch to correct chain
  const targetChainId = EVM_CHAIN_IDS[chainId];
  if (targetChainId) {
    try {
      await provider.send("wallet_switchEthereumChain", [{ chainId: targetChainId }]);
    } catch (err: unknown) {
      const switchErr = err as { code?: number };
      if (switchErr.code === 4902) {
        throw new Error(`Please add ${chainId} network to your wallet`);
      }
      throw err;
    }
  }

  const signer = await provider.getSigner();
  const address = await signer.getAddress();
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
