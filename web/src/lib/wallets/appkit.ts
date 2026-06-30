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

// Use the canonical public URL so Coinbase Wallet SDK can validate the dApp origin.
// NEXT_PUBLIC_APP_URL must be set in production (e.g. https://pay.agentlabs.cc).
// Falls back to window.location.origin at runtime, then to the production URL.
// A mismatch between metadata.url and the actual page origin causes Coinbase Wallet
// to show "no valid asset found" during the WalletLink QR scan flow.
const appUrl =
  process.env.NEXT_PUBLIC_APP_URL ??
  (typeof window !== "undefined" ? window.location.origin : "https://pay.agentlabs.cc");

const ethersAdapter = new EthersAdapter();

export const appKit = createAppKit({
  adapters: [ethersAdapter],
  projectId: projectId ?? "placeholder",
  networks: [base, mainnet, arbitrum, baseSepolia, sepolia],
  defaultNetwork: base,
  metadata: {
    name: "OpenClawBox Payments",
    description: "Pay for OpenClawBox subscriptions with crypto",
    url: appUrl,
    icons: [`${appUrl}/globe.svg`],
  },
  // Rabby must be explicit — its WalletConnect Explorer listing is miscategorized as
  // "Injected Wallet" so it does not appear automatically in AppKit's featured list.
  // Coinbase Wallet ID ensures the dedicated Coinbase connector shows prominently.
  featuredWalletIds: [
    "18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1", // Rabby Wallet
    "fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa", // Coinbase Wallet
  ],
  // 'eoaOnly': WalletLink mobile QR only — bypasses Smart Wallet popup.
  // Smart Wallet ('all' or 'smartWalletOnly') requires dApp domain registration and
  // validates metadata.url against window.location.origin; any mismatch causes
  // Coinbase Wallet mobile to show "no valid asset found". For a payment dApp that
  // does not need Smart Wallet features, 'eoaOnly' is the correct preference.
  coinbasePreference: "eoaOnly",
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
type AppKitView = "ConnectingWalletConnectBasic" | "AllWallets" | "Connect";

export function openAndWaitForConnection(
  view?: AppKitView,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let unsub: (() => void) | undefined;
    unsub = appKit.subscribeState((state) => {
      if (!state.open) {
        unsub?.();
        if (appKit.getIsConnectedState()) {
          resolve();
        } else {
          reject(new Error("Wallet connection cancelled"));
        }
      }
    });
    appKit.open(view ? { view } : undefined).catch((err) => {
      unsub?.();
      reject(err);
    });
  });
}
