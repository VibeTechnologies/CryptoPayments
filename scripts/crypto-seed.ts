#!/usr/bin/env tsx
/**
 * crypto-seed.ts — Generate receiving wallets for all supported chains,
 * encrypt private keys in geth-compatible keystore V3 format,
 * update .env with wallet addresses, and push to GitHub secrets.
 *
 * Usage:
 *   pnpm tsx scripts/crypto-seed.ts                     # interactive password prompt
 *   pnpm tsx scripts/crypto-seed.ts --password <file>   # read password from file
 *   pnpm tsx scripts/crypto-seed.ts --password -        # read password from stdin
 *
 * Output:
 *   .secrets/crypto.json   — geth-compatible encrypted keystore (one file, all chains)
 *   .env                   — updated with WALLET_BASE, WALLET_ETH, WALLET_TON, WALLET_SOL
 *   GitHub secrets         — updated via `gh secret set`
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { execSync } from "node:child_process";

// --- EVM (viem) ---
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// --- TON ---
import { mnemonicNew, mnemonicToPrivateKey, keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

// --- Solana ---
import { Keypair } from "@solana/web3.js";

// ─────────────────────────────────────────────────────────────
// Geth Keystore V3 encryption (scrypt + AES-128-CTR + keccak256 MAC)
// ─────────────────────────────────────────────────────────────

/** keccak256 using Node.js crypto (same hash as Ethereum uses) */
function keccak256(data: Buffer): Buffer {
  return crypto.createHash("sha3-256").update(data).digest();
}

interface KeystoreV3 {
  version: 3;
  id: string;
  address: string; // lowercase hex, no 0x
  crypto: {
    ciphertext: string;
    cipherparams: { iv: string };
    cipher: "aes-128-ctr";
    kdf: "scrypt";
    kdfparams: {
      dklen: number;
      salt: string;
      n: number;
      r: number;
      p: number;
    };
    mac: string;
  };
}

function encryptKeystore(
  privateKeyHex: string,
  password: string,
  address: string
): KeystoreV3 {
  // Strip 0x prefix if present
  const privKeyBuf = Buffer.from(
    privateKeyHex.startsWith("0x") ? privateKeyHex.slice(2) : privateKeyHex,
    "hex"
  );

  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const uuid = crypto.randomUUID();

  // scrypt params matching geth defaults
  const n = 262144; // 2^18
  const r = 8;
  const p = 1;
  const dklen = 32;

  const derivedKey = crypto.scryptSync(Buffer.from(password, "utf-8"), salt, dklen, {
    N: n,
    r,
    p,
    maxmem: 512 * 1024 * 1024,
  });

  // AES-128-CTR: use first 16 bytes of derived key
  const encryptionKey = derivedKey.subarray(0, 16);
  const cipher = crypto.createCipheriv("aes-128-ctr", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(privKeyBuf), cipher.final()]);

  // MAC: keccak256(derivedKey[16:32] + ciphertext)
  const macInput = Buffer.concat([derivedKey.subarray(16, 32), ciphertext]);
  const mac = keccak256(macInput);

  return {
    version: 3,
    id: uuid,
    address: address.toLowerCase().replace(/^0x/, ""),
    crypto: {
      ciphertext: ciphertext.toString("hex"),
      cipherparams: { iv: iv.toString("hex") },
      cipher: "aes-128-ctr",
      kdf: "scrypt",
      kdfparams: {
        dklen,
        salt: salt.toString("hex"),
        n,
        r,
        p,
      },
      mac: mac.toString("hex"),
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Wallet generation
// ─────────────────────────────────────────────────────────────

interface WalletInfo {
  chain: string;
  address: string;
  privateKeyHex: string; // hex without 0x prefix
  extra?: Record<string, string>; // e.g. mnemonic for TON
}

function generateEvmWallet(): WalletInfo {
  const privateKey = generatePrivateKey(); // 0x-prefixed hex
  const account = privateKeyToAccount(privateKey);
  return {
    chain: "evm",
    address: account.address,
    privateKeyHex: privateKey.slice(2),
  };
}

async function generateTonWallet(): Promise<WalletInfo> {
  const mnemonic = await mnemonicNew(24);
  const keyPair = await mnemonicToPrivateKey(mnemonic);
  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });
  const address = wallet.address.toString({ bounceable: false });
  return {
    chain: "ton",
    address,
    privateKeyHex: Buffer.from(keyPair.secretKey).toString("hex"),
    extra: { mnemonic: mnemonic.join(" ") },
  };
}

function generateSolanaWallet(): WalletInfo {
  const keypair = Keypair.generate();
  return {
    chain: "solana",
    address: keypair.publicKey.toBase58(),
    privateKeyHex: Buffer.from(keypair.secretKey).toString("hex"),
  };
}

// ─────────────────────────────────────────────────────────────
// Password input
// ─────────────────────────────────────────────────────────────

async function getPassword(): Promise<string> {
  const args = process.argv.slice(2);
  const passwordIdx = args.indexOf("--password");

  if (passwordIdx !== -1 && args[passwordIdx + 1]) {
    const source = args[passwordIdx + 1];
    if (source === "-") {
      // Read from stdin (piped)
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
        break; // read just one line
      }
      return Buffer.concat(chunks).toString("utf-8").trim();
    }
    // Read from file
    return fs.readFileSync(source, "utf-8").trim();
  }

  // Interactive prompt
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr, // prompt to stderr so stdout stays clean
      terminal: true,
    });

    // Mask input
    const originalWrite = (process.stderr as any).write;
    let muted = false;

    rl.question("Enter encryption password: ", (answer) => {
      muted = false;
      (process.stderr as any).write = originalWrite;
      process.stderr.write("\n");

      rl.question("Confirm password: ", (confirm) => {
        rl.close();
        if (answer !== confirm) {
          console.error("Passwords do not match. Aborting.");
          process.exit(1);
        }
        resolve(answer);
      });

      muted = true;
      (process.stderr as any).write = function (
        chunk: string | Uint8Array,
        ...args: any[]
      ) {
        if (muted && typeof chunk === "string" && !chunk.includes("Confirm")) {
          return originalWrite.call(process.stderr, "*");
        }
        return originalWrite.apply(process.stderr, [chunk, ...args]);
      };
    });

    muted = true;
    (process.stderr as any).write = function (
      chunk: string | Uint8Array,
      ...args: any[]
    ) {
      if (muted && typeof chunk === "string" && !chunk.includes("Enter")) {
        return originalWrite.call(process.stderr, "*");
      }
      return originalWrite.apply(process.stderr, [chunk, ...args]);
    };
  });
}

// ─────────────────────────────────────────────────────────────
// .env file update
// ─────────────────────────────────────────────────────────────

function updateEnvFile(
  envPath: string,
  updates: Record<string, string>
): void {
  let content = "";
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf-8");
  }

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    const line = `${key}=${value}`;
    if (regex.test(content)) {
      content = content.replace(regex, line);
    } else {
      content = content.trimEnd() + "\n" + line + "\n";
    }
  }

  fs.writeFileSync(envPath, content, "utf-8");
}

// ─────────────────────────────────────────────────────────────
// GitHub secrets
// ─────────────────────────────────────────────────────────────

function setGitHubSecret(name: string, value: string): void {
  try {
    execSync(`gh secret set ${name}`, {
      input: value,
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.log(`  GitHub secret ${name} ✓`);
  } catch (err: any) {
    console.error(
      `  GitHub secret ${name} FAILED: ${err.stderr?.toString().trim() || err.message}`
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log("=== CryptoPayments Wallet Seed ===\n");

  // 1. Get password
  const password = await getPassword();
  if (!password || password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  // 2. Generate wallets
  console.log("\nGenerating wallets...");
  const evmWallet = generateEvmWallet();
  const tonWallet = await generateTonWallet();
  const solWallet = generateSolanaWallet();

  console.log(`  EVM (Base+ETH): ${evmWallet.address}`);
  console.log(`  TON:            ${tonWallet.address}`);
  console.log(`  Solana:         ${solWallet.address}`);

  // 3. Encrypt private keys in geth keystore V3 format
  console.log("\nEncrypting private keys (scrypt N=262144)...");
  const keystores: Record<string, KeystoreV3> = {
    evm: encryptKeystore(evmWallet.privateKeyHex, password, evmWallet.address),
    ton: encryptKeystore(tonWallet.privateKeyHex, password, tonWallet.address),
    solana: encryptKeystore(
      solWallet.privateKeyHex,
      password,
      solWallet.address
    ),
  };

  // Include TON mnemonic as separate encrypted blob
  if (tonWallet.extra?.mnemonic) {
    const mnemonicHex = Buffer.from(tonWallet.extra.mnemonic, "utf-8").toString(
      "hex"
    );
    keystores.ton_mnemonic = encryptKeystore(
      mnemonicHex,
      password,
      tonWallet.address
    );
  }

  // 4. Save encrypted keystore
  const secretsDir = path.join(process.cwd(), ".secrets");
  fs.mkdirSync(secretsDir, { recursive: true });
  const keystorePath = path.join(secretsDir, "crypto.json");
  fs.writeFileSync(
    keystorePath,
    JSON.stringify(
      {
        version: 1,
        generated: new Date().toISOString(),
        description:
          "CryptoPayments receiving wallets. Private keys encrypted with geth keystore V3 (scrypt + AES-128-CTR). Decrypt with the seed password.",
        wallets: {
          evm: {
            address: evmWallet.address,
            chains: ["base", "ethereum"],
            keystore: keystores.evm,
          },
          ton: {
            address: tonWallet.address,
            chains: ["ton"],
            keystore: keystores.ton,
            mnemonic_keystore: keystores.ton_mnemonic,
          },
          solana: {
            address: solWallet.address,
            chains: ["solana"],
            keystore: keystores.solana,
          },
        },
      },
      null,
      2
    ),
    "utf-8"
  );
  console.log(`  Keystore saved: ${keystorePath}`);

  // Ensure .secrets is in .gitignore
  const gitignorePath = path.join(process.cwd(), ".gitignore");
  let gitignore = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, "utf-8")
    : "";
  if (!gitignore.includes(".secrets")) {
    gitignore = gitignore.trimEnd() + "\n.secrets/\n";
    fs.writeFileSync(gitignorePath, gitignore, "utf-8");
    console.log("  Added .secrets/ to .gitignore");
  }

  // 5. Generate API_KEY and CALLBACK_SECRET if not already in .env
  const envPath = path.join(process.cwd(), ".env");
  let existingEnv = "";
  if (fs.existsSync(envPath)) {
    existingEnv = fs.readFileSync(envPath, "utf-8");
  }

  const apiKey = existingEnv.match(/^API_KEY=(.+)$/m)?.[1] ||
    `cpk_${crypto.randomBytes(24).toString("hex")}`;
  const callbackSecret = existingEnv.match(/^CALLBACK_SECRET=(.+)$/m)?.[1] ||
    crypto.randomBytes(32).toString("hex");

  // 6. Update .env
  console.log("\nUpdating .env...");
  const envUpdates: Record<string, string> = {
    WALLET_BASE: evmWallet.address,
    WALLET_ETH: evmWallet.address,
    WALLET_TON: tonWallet.address,
    WALLET_SOL: solWallet.address,
    API_KEY: apiKey,
    CALLBACK_SECRET: callbackSecret,
    SUPABASE_URL: `https://wxxnkncwneyhmudfyayd.supabase.co`,
  };
  updateEnvFile(envPath, envUpdates);
  console.log("  .env updated ✓");

  // 7. Update GitHub secrets
  console.log("\nUpdating GitHub secrets...");
  const ghSecrets: Record<string, string> = {
    WALLET_BASE: evmWallet.address,
    WALLET_ETH: evmWallet.address,
    WALLET_TON: tonWallet.address,
    WALLET_SOL: solWallet.address,
    API_KEY: apiKey,
    CALLBACK_SECRET: callbackSecret,
    SUPABASE_URL: `https://wxxnkncwneyhmudfyayd.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: existingEnv.match(
      /^SUPABASE_SERVICE_ROLE_KEY=(.+)$/m
    )?.[1] || "",
  };

  for (const [name, value] of Object.entries(ghSecrets)) {
    if (value) {
      setGitHubSecret(name, value);
    } else {
      console.log(`  Skipping ${name} (empty value)`);
    }
  }

  // 8. Summary
  console.log("\n=== Summary ===");
  console.log(`Wallets generated and encrypted at: ${keystorePath}`);
  console.log(`Environment updated at: ${envPath}`);
  console.log(`GitHub secrets updated for: ${Object.keys(ghSecrets).join(", ")}`);
  console.log(
    "\nIMPORTANT: Back up .secrets/crypto.json and remember your password!"
  );
  console.log(
    "Without the password, the private keys CANNOT be recovered.\n"
  );

  // Print addresses for easy copy
  console.log("Receiving addresses:");
  console.log(`  Base/ETH: ${evmWallet.address}`);
  console.log(`  TON:      ${tonWallet.address}`);
  console.log(`  Solana:   ${solWallet.address}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
