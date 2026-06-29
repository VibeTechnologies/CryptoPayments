// AppKit singleton — WalletConnect v2 + Coinbase Wallet mobile QR connect
// Reown AppKit (formerly WalletConnect Web3Modal v3)
// Import this module once (in providers.tsx) as a side-effect to initialize the singleton.

import { createAppKit } from "@reown/appkit";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { base, mainnet, arbitrum, baseSepolia, sepolia } from "@reown/appkit/networks";
import { BrowserProvider } from "ethers";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
if (!projectId) {
  console.warn(
    "[AppKit] NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set. " +
    "Mobile QR connect will not work. Register a free project at https://dashboard.reown.com",
  );
}

const ethersAdapter = new EthersAdapter();

export const appKit = createAppKit({
  adapters: [ethersAdapter],
  projectId: projectId ?? "placeholder",
  networks: [base, mainnet, arbitrum, baseSepolia, sepolia],
  defaultNetwork: base,
  metadata: {
    name: "OpenClawBox Payments",
    description: "Pay for OpenClawBox subscriptions with crypto",
    url: "https://pay.oclawbox.com",
    icons: ["https://pay.oclawbox.com/icon.png"],
  },
  // Rabby must be explicit — its WalletConnect Explorer listing is miscategorized as
  // "Injected Wallet" so it does not appear automatically in AppKit's featured list.
  // Coinbase Wallet ID ensures the dedicated Coinbase connector shows prominently.
  featuredWalletIds: [
    "18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1", // Rabby Wallet
    "fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa", // Coinbase Wallet
  ],
  // 'all': show Coinbase Smart Wallet popup AND WalletLink mobile QR
  // 'eoaOnly': WalletLink mobile QR only (no Smart Wallet)
  coinbasePreference: "all",
  features: {
    analytics: false,
    email: false,
    socials: [],
  },
});

/**
 * Get an ethers v6 Signer from the active AppKit WalletConnect session.
 * Call this after appKit.open() resolves and getIsConnected() is true.
 */
export async function getAppKitSigner() {
  const provider = appKit.getProvider("eip155");
  if (!provider) throw new Error("No WalletConnect session");
  const ethersProvider = new BrowserProvider(provider as Parameters<typeof BrowserProvider>[0]);
  return ethersProvider.getSigner();
}
