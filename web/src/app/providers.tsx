"use client";

import "@/lib/wallets/appkit"; // initialize AppKit singleton once on app load
import { TonConnectUIProvider } from "@tonconnect/ui-react";

const MANIFEST_URL = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://pay.agentlabs.cc"}/tonconnect-manifest.json`;

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TonConnectUIProvider manifestUrl={MANIFEST_URL}>
      {children}
    </TonConnectUIProvider>
  );
}
