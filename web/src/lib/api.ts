// API client for the CryptoPayments Edge Function

import { API_BASE, type AppConfig, type PaymentRequest, type PaymentResult } from "./config";

export async function fetchConfig(): Promise<AppConfig> {
  const res = await fetch(`${API_BASE}/api/config`);
  if (!res.ok) throw new Error(`Failed to load config: ${res.status}`);
  return res.json();
}

export async function submitPayment(body: PaymentRequest): Promise<PaymentResult> {
  const res = await fetch(`${API_BASE}/api/payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (res.status === 409) {
    throw new Error("This transaction was already submitted.");
  }
  if (!res.ok) {
    throw new Error(data.error || `Verification failed (${res.status})`);
  }
  return data;
}

export async function checkPaymentStatus(id: string): Promise<PaymentResult> {
  const res = await fetch(`${API_BASE}/api/payment/${id}`);
  if (!res.ok) throw new Error(`Payment not found: ${res.status}`);
  return res.json();
}
