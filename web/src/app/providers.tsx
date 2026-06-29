"use client";

import "@/lib/wallets/appkit"; // initialize AppKit singleton once on app load
import { TonConnectUIProvider } from "@tonconnect/ui-react";

const MANIFEST_URL = "https://pay.oclawbox.com/tonconnect-manifest.json";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TonConnectUIProvider manifestUrl={MANIFEST_URL}>
      {children}
    </TonConnectUIProvider>
  );
}
