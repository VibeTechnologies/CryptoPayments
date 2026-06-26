#!/usr/bin/env bun
import { Wallet } from "ethers";
import QRCode from "qrcode";
import { readdir, writeFile } from "node:fs/promises";

const OUTPUT_DIR = ".";

async function getNextWalletIndex(): Promise<number> {
	const files = await readdir(OUTPUT_DIR);
	const indexes = files
		.map((file) => file.match(/^wallet-(\d+)\.json$/)?.[1])
		.filter((value): value is string => value !== undefined)
		.map((value) => Number(value))
		.filter((value) => Number.isInteger(value));

	if (indexes.length === 0) {
		return 1;
	}

	return Math.max(...indexes) + 1;
}

async function main(): Promise<void> {
	const index = await getNextWalletIndex();
	const jsonPath = `${OUTPUT_DIR}/wallet-${index}.json`;
	const pngPath = `${OUTPUT_DIR}/wallet-${index}.png`;

	const wallet = Wallet.createRandom();
	const mnemonicPhrase = wallet.mnemonic?.phrase;
	const publicKey = wallet.signingKey.publicKey;
	const addressUri = `ethereum:${wallet.address}`;

	const walletRecord = {
		index,
		createdAt: new Date().toISOString(),
		address: wallet.address,
		publicKey,
		privateKey: wallet.privateKey,
		mnemonic: mnemonicPhrase ?? null,
		qrPayload: addressUri,
	};

	await writeFile(jsonPath, `${JSON.stringify(walletRecord, null, 2)}\n`, "utf8");
	await QRCode.toFile(pngPath, addressUri, { width: 400, margin: 1 });

	console.log("Private Key:", wallet.privateKey);
	console.log("Public Key:", publicKey);
	console.log("Address:", wallet.address);

	if (mnemonicPhrase) {
		console.log("Mnemonic (Seed Phrase):", mnemonicPhrase);
	} else {
		console.log("Mnemonic (Seed Phrase): not available");
	}

	console.log("\nQR Payload:", addressUri);
	console.log("\nAddress QR (terminal):");
	console.log(await QRCode.toString(addressUri, { type: "terminal", small: true }));
	console.log(`Saved wallet JSON to ${jsonPath}`);
	console.log(`Saved QR image to ${pngPath}`);
}

main().catch((error: unknown) => {
	console.error("Failed to generate wallet + QR code:", error);
	process.exit(1);
});