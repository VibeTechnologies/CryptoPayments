// TON wallet (TonConnect) integration
// Uses @tonconnect/ui-react for React components, @ton/core for cell serialization

import { beginCell, Address, toNano } from "@ton/core";

export function isTonAvailable(): boolean {
  // TonConnect works via QR code / deep links, always available
  return true;
}

export interface TonTransferParams {
  jettonAddress: string;
  toAddress: string;
  amountUsd: number;
}

export function buildTonTransferMessage(params: TonTransferParams) {
  const { jettonAddress, toAddress, amountUsd } = params;
  const amount = Math.round(amountUsd * 1e6); // USDC/USDT = 6 decimals

  // Jetton transfer requires sending a message to the sender's jetton wallet
  // with 0.05 TON attached for gas
  const forwardTon = "50000000"; // 0.05 TON in nanotons

  return {
    validUntil: Math.floor(Date.now() / 1000) + 600, // 10 min
    messages: [
      {
        address: jettonAddress,
        amount: forwardTon,
        payload: buildJettonTransferCell(toAddress, amount),
      },
    ],
  };
}

/**
 * Build a BOC cell for jetton transfer (TEP-74 standard).
 *
 * Cell layout:
 *   uint32  op = 0x0f8a7ea5 (transfer)
 *   uint64  query_id = 0
 *   coins   amount (jetton amount in smallest units)
 *   address destination
 *   address response_destination (sender — for excess TON return)
 *   bit     custom_payload flag = 0
 *   coins   forward_ton_amount = 0 (no notification needed)
 *   bit     forward_payload flag = 0
 *
 * @returns base64-encoded BOC string for TonConnect payload
 */
function buildJettonTransferCell(destAddress: string, amount: number): string {
  const dest = Address.parse(destAddress);

  const body = beginCell()
    .storeUint(0x0f8a7ea5, 32) // op: transfer
    .storeUint(0, 64) // query_id
    .storeCoins(BigInt(amount)) // jetton amount
    .storeAddress(dest) // destination
    .storeAddress(dest) // response_destination (excess TON goes to recipient)
    .storeBit(false) // no custom_payload
    .storeCoins(0) // forward_ton_amount
    .storeBit(false) // no forward_payload
    .endCell();

  return body.toBoc().toString("base64");
}
