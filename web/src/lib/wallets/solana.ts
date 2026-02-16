// Solana wallet (Phantom) integration

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

declare global {
  interface Window {
    phantom?: {
      solana?: {
        isPhantom?: boolean;
        connect: () => Promise<{ publicKey: PublicKey }>;
        signAndSendTransaction: (tx: Transaction) => Promise<{ signature: string }>;
      };
    };
  }
}

const SOL_RPC = "https://api.mainnet-beta.solana.com";

export function isSolanaAvailable(): boolean {
  return typeof window !== "undefined" && !!window.phantom?.solana;
}

export async function connectSolana(): Promise<{ publicKey: PublicKey; address: string }> {
  const phantom = window.phantom?.solana;
  if (!phantom) throw new Error("Phantom wallet not detected");

  const resp = await phantom.connect();
  return {
    publicKey: resp.publicKey,
    address: resp.publicKey.toString(),
  };
}

export async function sendSolanaTransfer(
  mintAddress: string,
  toWallet: string,
  amountUsd: number,
): Promise<string> {
  const phantom = window.phantom?.solana;
  if (!phantom) throw new Error("Phantom not available");

  const connection = new Connection(SOL_RPC, "confirmed");
  const resp = await phantom.connect();
  const fromPubkey = resp.publicKey;

  const mint = new PublicKey(mintAddress);
  const toPubkey = new PublicKey(toWallet);

  const fromAta = await getAssociatedTokenAddress(mint, fromPubkey);
  const toAta = await getAssociatedTokenAddress(mint, toPubkey);

  // Check if recipient ATA exists
  const toAtaInfo = await connection.getAccountInfo(toAta);
  if (!toAtaInfo) {
    throw new Error("Recipient token account not found. Please send manually.");
  }

  const amount = Math.round(amountUsd * 1e6); // 6 decimals

  const ix = createTransferInstruction(
    fromAta,
    toAta,
    fromPubkey,
    amount,
    [],
    TOKEN_PROGRAM_ID,
  );

  const tx = new Transaction().add(ix);
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  tx.recentBlockhash = blockhash;
  tx.feePayer = fromPubkey;

  const { signature } = await phantom.signAndSendTransaction(tx);
  return signature;
}
