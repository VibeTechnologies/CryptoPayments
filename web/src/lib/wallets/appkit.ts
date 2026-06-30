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
 * Call after openAndWaitForConnection() resolves.
 */
export async function getAppKitSigner() {
  const provider = appKit.getProvider("eip155");
  if (!provider) throw new Error("No WalletConnect session");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ethersProvider = new BrowserProvider(provider as any);
  return ethersProvider.getSigner();
}

/**
 * Open the AppKit modal and wait for the user to complete wallet connection.
 *
 * appKit.open() resolves as soon as the modal is displayed — not when the
 * WalletConnect handshake finishes. We must subscribe to state changes before
 * calling open() and wait for the modal to close (state.open = false).
 * If the modal closes with a connected session, the promise resolves.
 * If the modal closes without a connection (user cancelled), it rejects.
 */
export function openAndWaitForConnection(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Declare unsub as let so synchronous subscribeState callbacks (e.g. in tests)
    // can safely call unsub?.() before the assignment completes without TDZ crash.
    let unsub: (() => void) | undefined;
    // Subscribe BEFORE open() so we never miss the close event
    unsub = appKit.subscribeState((state) => {
      if (!state.open) {
        unsub?.(); // no-op if called synchronously before assignment completes
        if (appKit.getIsConnectedState()) {
          resolve();
        } else {
          reject(new Error("Wallet connection cancelled"));
        }
      }
    });
    appKit.open().catch((err) => {
      unsub?.();
      reject(err);
    });
  });
}
