// EVM wallet integration via ethers.js v6 (works with any EIP-1193 wallet)

import { BrowserProvider, Contract, getAddress, parseUnits, type Signer } from "ethers";
import { ERC20_ABI, EVM_CHAIN_IDS, EVM_CHAIN_PARAMS, type ChainId } from "../config";

// @reown/appkit augments Window.ethereum as Record<string,unknown>; match that
// to avoid a TS "Subsequent property declarations" conflict. We cast at point of use.
type EthereumProvider = {
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};
function getEthereum(): EthereumProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { ethereum?: EthereumProvider }).ethereum;
}

/** True when the page is running inside the Coinbase Wallet / Base in-app browser. */
function isInCoinbaseApp(): boolean {
  const eth = getEthereum();
  return !!eth && !!(eth as { isCoinbaseWallet?: boolean }).isCoinbaseWallet;
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provider = new BrowserProvider(eth as any);
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
 * Connect via Coinbase Wallet (Base network official wallet).
 *
 * - If already inside the Coinbase/Base in-app browser (isCoinbaseWallet injected),
 *   use window.ethereum directly — no QR needed, wallet is right there.
 * - Otherwise (desktop browser): use @coinbase/wallet-sdk with eoaOnly to show
 *   Coinbase's own QR popup for mobile scan.
 */
export async function connectEvmCoinbase(
  chainId: ChainId,
): Promise<{ signer: Signer; address: string }> {
  // Already inside Coinbase Wallet / Base app — use the injected provider directly.
  if (isInCoinbaseApp()) {
    return connectEvm(chainId);
  }

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    (typeof window !== "undefined" ? window.location.origin : "https://pay.agentlabs.cc");

  const { CoinbaseWalletSDK } = await import("@coinbase/wallet-sdk");
  const sdk = new CoinbaseWalletSDK({
    appName: "OpenClawBox Payments",
    appLogoUrl: `${appUrl}/globe.svg`,
    appChainIds: [8453], // Base mainnet
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cbProvider = sdk.makeWeb3Provider({ options: "eoaOnly" }) as any;
  // Triggers Coinbase Wallet SDK's native QR popup — opens keys.coinbase.com
  const accounts = (await cbProvider.request({ method: "eth_requestAccounts" })) as string[];

  const provider = new BrowserProvider(cbProvider);

  const targetChainId = EVM_CHAIN_IDS[chainId];
  if (targetChainId) {
    try {
      await provider.send("wallet_switchEthereumChain", [{ chainId: targetChainId }]);
    } catch (err: unknown) {
      if (isChainNotAddedError(err)) {
        const chainParams = EVM_CHAIN_PARAMS[chainId];
        if (chainParams) await provider.send("wallet_addEthereumChain", [chainParams]);
      } else {
        throw err;
      }
    }
  }

  const signer = await provider.getSigner();
  return { signer, address: accounts[0] };
}

/**
 * Connect via WalletConnect v2 QR directly (skips wallet list, shows QR immediately).
 */
export async function connectEvmWalletConnect(
  chainId: ChainId,
): Promise<{ signer: Signer; address: string }> {
  return connectEvmAppKit(chainId, "ConnectingWalletConnectBasic");
}

async function connectEvmAppKit(
  chainId: ChainId,
  view: "AllWallets" | "ConnectingWalletConnectBasic" | "Connect",
): Promise<{ signer: Signer; address: string }> {
  const { openAndWaitForConnection, getAppKitSigner } = await import("./appkit");

  await openAndWaitForConnection(view);

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
  // getAddress() enforces EIP-55 checksum — prevents ethers v6 ENS lookup
  // for recipient addresses that are always plain hex, never ENS names.
  const tx = await contract.transfer(getAddress(toAddress), amount);
  return tx.hash;
}
