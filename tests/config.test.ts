import { describe, it, expect, beforeEach, afterEach } from "vitest";

// AGE-960 / GH#49: each viem chain must resolve to an ORDERED LIST of RPC
// endpoints (failover targets), not a single free public URL with no
// fallback. This is what turned one slow public RPC into a fully-failed
// customer payment.

const RPC_ENV_KEYS = [
  "RPC_BASE",
  "RPC_ETH",
  "RPC_ARBITRUM",
  "RPC_BASE_SEPOLIA",
  "RPC_ETH_SEPOLIA",
] as const;

describe("loadConfig — RPC endpoint lists", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of RPC_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of RPC_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("defaults every viem chain to 2+ endpoints (no single-RPC SPOF)", async () => {
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.rpc.eth.length).toBeGreaterThanOrEqual(2);
    expect(config.rpc.base.length).toBeGreaterThanOrEqual(2);
    expect(config.rpc.arbitrum.length).toBeGreaterThanOrEqual(2);
    expect(config.rpc.eth_sepolia.length).toBeGreaterThanOrEqual(2);
    expect(config.rpc.base_sepolia.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves today's documented default as index 0 (no surprise reordering for existing operators)", async () => {
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.rpc.eth[0]).toBe("https://cloudflare-eth.com");
    expect(config.rpc.base[0]).toBe("https://mainnet.base.org");
    expect(config.rpc.arbitrum[0]).toBe("https://arb1.arbitrum.io/rpc");
    expect(config.rpc.eth_sepolia[0]).toBe("https://ethereum-sepolia-rpc.publicnode.com");
  });

  it("a comma-separated env var overrides the full endpoint list, in order", async () => {
    process.env.RPC_ETH = "https://paid-provider.example/v1,https://fallback.example";
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.rpc.eth).toEqual([
      "https://paid-provider.example/v1",
      "https://fallback.example",
    ]);
  });

  it("a single-URL env var override still yields a 1-element list (no forced fallback added)", async () => {
    process.env.RPC_BASE = "https://only-provider.example";
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.rpc.base).toEqual(["https://only-provider.example"]);
  });
});
