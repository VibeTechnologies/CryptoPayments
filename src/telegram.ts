import { createHmac } from "node:crypto";

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export interface InitDataResult {
  valid: boolean;
  user?: TelegramUser;
  authDate?: number;
  queryId?: string;
  startParam?: string;
}

/**
 * Verify Telegram Mini App initData.
 *
 * Algorithm (from Telegram docs):
 * 1. Parse initData as URLSearchParams
 * 2. Extract `hash`, remove it from params
 * 3. Sort remaining key=value pairs alphabetically
 * 4. Join with \n → data_check_string
 * 5. secret_key = HMAC_SHA256("WebAppData", bot_token)
 * 6. calculated_hash = hex(HMAC_SHA256(data_check_string, secret_key))
 * 7. Compare calculated_hash === hash
 * 8. Check auth_date is recent (< 1 hour)
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 3600,
): InitDataResult {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { valid: false };

  // Build data check string: sorted key=value pairs, excluding hash
  params.delete("hash");
  const entries: string[] = [];
  params.forEach((value, key) => {
    entries.push(`${key}=${value}`);
  });
  entries.sort();
  const dataCheckString = entries.join("\n");

  // HMAC verification
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculatedHash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (calculatedHash !== hash) {
    return { valid: false };
  }

  // Check auth_date freshness
  const authDate = Number(params.get("auth_date") || 0);
  const now = Math.floor(Date.now() / 1000);
  if (now - authDate > maxAgeSeconds) {
    return { valid: false };
  }

  // Parse user
  let user: TelegramUser | undefined;
  const userJson = params.get("user");
  if (userJson) {
    try {
      user = JSON.parse(userJson);
    } catch {
      // ignore parse errors
    }
  }

  return {
    valid: true,
    user,
    authDate,
    queryId: params.get("query_id") ?? undefined,
    startParam: params.get("start_param") ?? undefined,
  };
}
