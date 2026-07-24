#!/usr/bin/env tsx
/**
 * send-ausd.ts — Send agentUSD (aUSD, ERC-20, 6 decimals) on Ethereum Sepolia
 * from a testnet wallet file.
 *
 * Usage (from repo root):
 *   pnpm tsx testnet/send-ausd.ts <to> <amount> [--wallet testnet/wallet-2.json]
 *
 * Examples:
 *   pnpm tsx testnet/send-ausd.ts 0x9945ba0a781200b90b4c28528cced309abb90871 100
 *   pnpm tsx testnet/send-ausd.ts 0xRecipient 5 --wallet testnet/wallet-2.json
 *
 * Defaults to testnet/wallet-1.json (resolved relative to this script).
 *
 * Env overrides:
 *   AUSD_ADDRESS   aUSD contract (default 0xfCCfda616e5107AC579712C5A461397f88e8e3f2)
 *   SEPOLIA_RPC    RPC URL       (default https://ethereum-sepolia-rpc.publicnode.com)
 *
 * <amount> is a human aUSD value (e.g. "100", "5.5"); it is scaled by 6 decimals.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  getAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const AUSD_ADDRESS = getAddress(
  process.env.AUSD_ADDRESS ?? "0xfCCfda616e5107AC579712C5A461397f88e8e3f2",
);
const RPC_URL =
  process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const DECIMALS = 6;

const ERC20_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function parseArgs(argv: string[]): {
  to: `0x${string}`;
  amount: string;
  wallet: string;
} {
  const positional: string[] = [];
  let wallet = path.join(SCRIPT_DIR, "wallet-1.json");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--wallet") {
      wallet = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  const [to, amount] = positional;
  if (!to || !amount) {
    console.error(
      "Usage: pnpm tsx testnet/send-ausd.ts <to> <amount> [--wallet testnet/wallet-2.json]",
    );
    process.exit(1);
  }
  return { to: getAddress(to), amount, wallet };
}

async function main(): Promise<void> {
  const { to, amount, wallet } = parseArgs(process.argv.slice(2));

  const walletJson = JSON.parse(fs.readFileSync(wallet, "utf8")) as {
    privateKey: string;
    address: string;
  };
  const pk = (
    walletJson.privateKey.startsWith("0x")
      ? walletJson.privateKey
      : `0x${walletJson.privateKey}`
  ) as Hex;
  const account = privateKeyToAccount(pk);

  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(RPC_URL),
  });
  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(RPC_URL),
  });

  const value = parseUnits(amount, DECIMALS);
  const before = (await publicClient.readContract({
    address: AUSD_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;

  if (before < value) {
    console.error(
      `Insufficient aUSD: have ${formatUnits(before, DECIMALS)}, need ${amount}`,
    );
    process.exit(1);
  }

  console.log(`from   ${account.address}  (${formatUnits(before, DECIMALS)} aUSD)`);
  console.log(`send   ${amount} aUSD  ->  ${to}`);

  const hash = await walletClient.writeContract({
    address: AUSD_ADDRESS,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to, value],
  });
  console.log(`tx     ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const recipientBal = (await publicClient.readContract({
    address: AUSD_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [to],
  })) as bigint;

  console.log(`status ${receipt.status}  block ${receipt.blockNumber}`);
  console.log(`to bal ${formatUnits(recipientBal, DECIMALS)} aUSD`);
  console.log(`https://sepolia.etherscan.io/tx/${hash}`);

  if (receipt.status !== "success") process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
