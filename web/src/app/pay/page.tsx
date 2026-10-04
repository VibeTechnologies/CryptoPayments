"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchConfig, submitPayment, checkPaymentStatus } from "@/lib/api";
import {
  buildPaymentBodyFromIntent,
  canonicalIntentString,
  findInvalidSignedIntentParams,
  isUnexpiredExp,
  rawIntentCanonicalString,
  SEND_MIN_REMAINING_SEC,
  type IntentBody,
} from "@/lib/intent";

const INVALID_SIGNED_LINK_MESSAGE =
  "This payment link is invalid or was modified. Request a new link.";
const EXPIRED_SIGNED_LINK_MESSAGE =
  "This payment link has expired. Request a new link.";
const EXPIRING_SIGNED_LINK_MESSAGE =
  "This payment link expires too soon to complete a payment. Request a new link.";
const SIGNED_UID_MISMATCH_MESSAGE =
  "This payment link was issued for a different Telegram account. Open it from the account that requested it.";

/** Placement/runtime fields: only trusted (and forwarded) under a signature. */
const SIGNED_ONLY_BODY_FIELDS = ["tenantType", "vmProvider", "hostType", "deploymentType"] as const;

/**
 * Pre-send guard for a signed link. Returns the user-facing error, or null
 * when the link may be paid. Runs at mount AND right before the wallet
 * transfer (exp may lapse while the page is open).
 */
function signedLinkError(
  params: URLSearchParams,
  telegramUserId: string | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): string | null {
  if (!params.has("sig")) return null;
  const invalid = findInvalidSignedIntentParams(params, nowSec);
  if (invalid.length === 1 && invalid[0] === "exp") {
    // Well-formed but lapsed (would be valid with an earlier clock) -> expired;
    // malformed / non-finite (e.g. 310 nines) -> invalid.
    if (isUnexpiredExp(params.get("exp"), -1)) return EXPIRED_SIGNED_LINK_MESSAGE;
  }
  if (invalid.length > 0) return INVALID_SIGNED_LINK_MESSAGE;
  // Refuse to START a send that could outlive the link: wallet approval +
  // mining + POST must fit before exp (the server adds a post-exp grace only
  // for transfers already in flight).
  if (Number(params.get("exp")) - nowSec < SEND_MIN_REMAINING_SEC) return EXPIRING_SIGNED_LINK_MESSAGE;
  if (telegramUserId !== null && telegramUserId !== params.get("uid")) {
    return SIGNED_UID_MISMATCH_MESSAGE;
  }
  return null;
}
/**
 * The exact signed fields POSTed for a signed link: URL-derived only, never
 * defaulted (no implicit plan="starter", no Telegram-derived uid/idType).
 * `sig` is included; it is not part of the canonical string.
 */
function signedPostFields(params: URLSearchParams): IntentBody {
  return buildPaymentBodyFromIntent(params);
}

/**
 * Final parity guard at the wallet-send boundary: the canonical string of the
 * signed fields that will be POSTed must equal the raw canonical string of the
 * URL the signer HMAC'd. Otherwise the server would 401 after the transfer.
 */
function signedFieldsMatchUrl(fields: IntentBody, params: URLSearchParams): boolean {
  if (fields.idType !== "tg") return false;
  return canonicalIntentString(fields) === rawIntentCanonicalString(params);
}

import {
  type AppConfig,
  type ChainId,
  type TokenId,
  CHAINS,
  TOKENS,
} from "@/lib/config";
import { ChainSelector } from "@/components/chain-selector";
import { TokenSelector } from "@/components/token-selector";
import { AmountDisplay } from "@/components/amount-display";
import { WalletConnect } from "@/components/wallet-connect";
import { StatusMessage, type StatusType } from "@/components/status-message";

const TOPUP_PACKS: Record<string, { label: string; price: number; stars: number }> = {
  small:  { label: "Small Pack",  price: 5,  stars: 200 },
  medium: { label: "Medium Pack", price: 10, stars: 400 },
  large:  { label: "Large Pack",  price: 25, stars: 1000 },
};

// Telegram WebApp types
declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready: () => void;
        expand: () => void;
        close: () => void;
        initData: string;
        initDataUnsafe?: {
          user?: { id: number; first_name?: string };
          start_param?: string;
        };
        themeParams?: Record<string, string>;
      };
    };
  }
}

export default function PayPage() {
  // Config from API
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);

  // Payment params (from URL query or Telegram start_param)
  const [plan, setPlan] = useState("starter");
  const [topup, setTopup] = useState("");
  const [uid, setUid] = useState("");
  const [idType, setIdType] = useState<"tg" | "email">("tg");
  const [callbackUrl, setCallbackUrl] = useState("");
  // Signed checkout-intent params, forwarded VERBATIM to /api/payment.
  // Never validate/normalise/default these client-side: the HMAC covers them.
  const [intentBody, setIntentBody] = useState<IntentBody>({});
  // A signed link that can never verify (non-tg idtype, empty signed key).
  // Payment is blocked BEFORE any on-chain transfer.
  const [invalidSignedLink, setInvalidSignedLink] = useState(false);
  // URL params + Telegram user id captured at mount, re-checked pre-send.
  const [urlParams, setUrlParams] = useState<URLSearchParams>(() => new URLSearchParams());
  const [telegramUserId, setTelegramUserId] = useState<string | null>(null);
  const [initData, setInitData] = useState("");
  const [userName, setUserName] = useState("");

  // Selection state
  const [selectedChain, setSelectedChain] = useState<ChainId>("base");
  const [selectedToken, setSelectedToken] = useState<TokenId>("usdc");

  // Testnet visibility (show only when ?test=true)
  const [showTestnets, setShowTestnets] = useState(false);

  // Payment state
  const [status, setStatus] = useState<{ type: StatusType; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [verified, setVerified] = useState(false);

  // Parse URL params and Telegram data on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tg = window.Telegram?.WebApp;

    // Enable testnets if ?test=true
    setShowTestnets(params.get("test") === "true");

    let pUid = params.get("uid") || "";
    let pPlan = params.get("plan") || "starter";
    const pTopup = params.get("topup") || "";
    let pIdType = (params.get("idtype") || "tg") as "tg" | "email";
    const pCallback = params.get("callback") || "";
    const pIntent = buildPaymentBodyFromIntent(params);
    const isSigned = params.has("sig");
    let pTelegramUserId: string | null = null;
    let pName = "";

    if (tg) {
      tg.ready();
      tg.expand();
      setInitData(tg.initData || "");
      if (tg.initDataUnsafe?.user) {
        const user = tg.initDataUnsafe.user;
        pTelegramUserId = String(user.id);
        if (!pUid) pUid = String(user.id);
        // A signed idtype is authoritative and must never be overwritten
        // (laundering idtype=email into "tg" would bypass the fail-closed check).
        if (!isSigned) pIdType = "tg";
        pName = user.first_name || "";
      }
      // Parse start_param: "plan_uid"
      // Note: top-ups are passed via the ?topup= query param, not start_param.
      // start_param carries only plan+uid for subscription flows.
      const startParam = tg.initDataUnsafe?.start_param;
      if (startParam && !params.get("uid")) {
        const parts = startParam.split("_");
        if (parts.length >= 2) {
          pPlan = parts[0];
          pUid = parts.slice(1).join("_");
        }
      }
    }

    setPlan(pPlan);
    setTopup(pTopup);
    setUid(pUid);
    setIdType(pIdType);
    setCallbackUrl(pCallback);
    setIntentBody(pIntent);
    setUrlParams(params);
    setTelegramUserId(pTelegramUserId);
    const pSignedError = signedLinkError(params, pTelegramUserId);
    setInvalidSignedLink(pSignedError !== null);
    if (pSignedError) setStatus({ type: "error", message: pSignedError });
    setUserName(pName || (pIdType === "tg" ? `User ${pUid}` : pUid));

    // Fetch config
    fetchConfig()
      .then(setConfig)
      .catch(() => setStatus({ type: "error", message: "Failed to load payment configuration" }))
      .finally(() => setLoading(false));
  }, []);

  const amountUsd = intentBody.amountUsd ?? "";

  // Reject unknown topup keys not backed by an explicit amount —
  // silently falling back would charge the wrong amount.
  const isUnknownTopup = topup !== "" && !(topup in TOPUP_PACKS) && !amountUsd;

  // Price: known top-up pack price, else explicit amountUsd, else plan price.
  const price = topup && topup in TOPUP_PACKS
    ? TOPUP_PACKS[topup].price
    : amountUsd
    ? Number(amountUsd)
    : (config?.prices[plan] ?? config?.prices.starter ?? 10);

  // Filter chains — hide testnets unless ?test=true
  const visibleChains = showTestnets ? CHAINS : CHAINS.filter((c) => !c.testnet);

  // Get wallet address for current chain
  const walletAddress = config?.wallets[selectedChain] ?? "";

  // Get token contract address
  const tokenAddress = config?.tokens[selectedChain]?.[selectedToken] ?? "";

  /** Poll GET /api/payment/:id until verified, failed, or timeout (90s). */
  async function pollPaymentVerified(id: string): Promise<void> {
    const POLL_INTERVAL_MS = 3_000;
    const MAX_ATTEMPTS = 30; // 90s total
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const result = await checkPaymentStatus(id);
      const payment = result.payment;
      if (payment?.status === "verified") {
        const topupKey = payment.topup_id || topup;
        const topupPack = topupKey ? TOPUP_PACKS[topupKey] : null;
        const label = topupPack
          ? `${topupPack.label} ($${topupPack.price}) — `
          : payment.plan_id
          ? `${payment.plan_id.charAt(0).toUpperCase() + payment.plan_id.slice(1)} plan — `
          : "";
        setStatus({
          type: "success",
          message: `Payment verified! ${label}$${payment.amount_usd.toFixed(2)} ${payment.token.toUpperCase()}`,
        });
        setVerified(true);
        if (window.Telegram?.WebApp) {
          setTimeout(() => window.Telegram?.WebApp?.close(), 3000);
        }
        return;
      }
      if (payment?.status === "failed") {
        setStatus({ type: "error", message: result.error || "Verification failed. Payment not found on-chain." });
        return;
      }
      // still pending — update spinner message with elapsed time
      const elapsed = ((i + 1) * POLL_INTERVAL_MS) / 1000;
      setStatus({ type: "pending", message: `Waiting for confirmation... (${elapsed}s)` });
    }
    // Timed out
    setStatus({
      type: "error",
      message: "Transaction is taking longer than expected. Check back in a few minutes.",
    });
  }

  /**
   * Called by WalletConnect immediately before it initiates the on-chain
   * transfer. Re-runs the signed-link guard (exp can lapse while the page is
   * open). Returning false aborts the send.
   */
  const beforeSend = useCallback((): boolean => {
    if (invalidSignedLink) {
      setStatus({ type: "error", message: INVALID_SIGNED_LINK_MESSAGE });
      return false;
    }
    const err = signedLinkError(urlParams, telegramUserId);
    if (err) {
      setInvalidSignedLink(true);
      setStatus({ type: "error", message: err });
      return false;
    }
    if (urlParams.get("sig") && !signedFieldsMatchUrl(signedPostFields(urlParams), urlParams)) {
      setInvalidSignedLink(true);
      setStatus({ type: "error", message: INVALID_SIGNED_LINK_MESSAGE });
      return false;
    }
    return true;
  }, [invalidSignedLink, urlParams, telegramUserId]);

  // Handle wallet transaction completion
  const handleTxSent = useCallback(
    async (hash: string) => {
      if (invalidSignedLink) {
        setStatus({ type: "error", message: INVALID_SIGNED_LINK_MESSAGE });
        return;
      }
      setStatus({ type: "pending", message: "Transaction sent. Verifying on-chain..." });
      await doSubmit(hash);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedChain, selectedToken, idType, uid, plan, topup, callbackUrl, initData, intentBody, invalidSignedLink, urlParams],
  );

  // Submit payment for verification
  async function doSubmit(hash: string) {
    if (!hash.trim()) {
      setStatus({ type: "error", message: "No transaction hash provided" });
      return;
    }
    setSubmitting(true);
    setStatus({ type: "pending", message: "Verifying transaction on-chain..." });

    try {
      const transport = {
        txHash: hash.trim(),
        chainId: selectedChain,
        token: selectedToken,
        initData: initData || undefined,
      };
      let result;
      if (urlParams.get("sig")) {
        // Signed link: ONLY the URL-derived signed fields (the same builder the
        // pre-send parity guard checked) plus unsigned transport fields. No
        // defaults for signed keys (no plan="starter", no Telegram uid).
        const fields = signedPostFields(urlParams);
        if (!signedFieldsMatchUrl(fields, urlParams)) {
          setInvalidSignedLink(true);
          setStatus({ type: "error", message: INVALID_SIGNED_LINK_MESSAGE });
          return;
        }
        result = await submitPayment({
          ...transport,
          ...fields,
          idType: fields.idType ?? "",
          uid: fields.uid ?? "",
        });
      } else {
        // Unsigned (legacy) link: the page's own computed fields (idType, uid,
        // plan, topup, callbackUrl) win over URL-derived ones, so the POSTed
        // plan is exactly the plan displayed and charged (e.g. Telegram
        // start_param `pro_42` overrides `?plan=starter`). Placement/runtime
        // fields are NOT forwarded (only trusted under a signature).
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { idType: _urlIdType, ...unsignedIntentFields } = intentBody;
        for (const field of SIGNED_ONLY_BODY_FIELDS) delete unsignedIntentFields[field];
        result = await submitPayment({
          ...unsignedIntentFields,
          ...transport,
          idType,
          uid,
          plan: topup ? undefined : plan,
          topup: topup || undefined,
          callbackUrl: callbackUrl || undefined,
        });
      }

      if (result.payment && result.payment.status !== "verified") {
        setStatus({ type: "pending", message: "Waiting for confirmation..." });
        await pollPaymentVerified(result.payment.id);
        return;
      }

      if (result.payment?.status === "verified") {
        const p = result.payment;
        const topupKey = p.topup_id || topup;
        const topupPack = topupKey ? TOPUP_PACKS[topupKey] : null;
        const label = topupPack
          ? `${topupPack.label} ($${topupPack.price}) — `
          : p.plan_id
          ? `${p.plan_id.charAt(0).toUpperCase() + p.plan_id.slice(1)} plan — `
          : "";
        setStatus({
          type: "success",
          message: `Payment verified! ${label}$${p.amount_usd.toFixed(2)} ${p.token.toUpperCase()}`,
        });
        setVerified(true);

        // Auto-close Telegram Mini App after 3s
        if (window.Telegram?.WebApp) {
          setTimeout(() => window.Telegram?.WebApp?.close(), 3000);
        }
      } else {
        setStatus({
          type: "error",
          message: result.error || "Verification failed. Check the hash and try again.",
        });
      }
    } catch (err) {
      setStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Verification failed",
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-accent" />
      </div>
    );
  }

  if (!uid) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="rounded-xl border border-border bg-surface p-6 text-center max-w-sm">
          <h1 className="text-lg font-semibold mb-2">No user identified</h1>
          <p className="text-sm text-muted">
            Open this page from the Telegram bot or use a payment link with your user ID.
          </p>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen p-4 pb-20">
      <div className="mx-auto max-w-lg">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight">Pay with Crypto</h1>
          <p className="mt-1 text-sm text-muted">
            {userName} —{" "}
            {topup
              ? `Credit Top-Up: ${TOPUP_PACKS[topup]?.label ?? `${topup.charAt(0).toUpperCase() + topup.slice(1)} top-up`}`
              : `${plan.charAt(0).toUpperCase() + plan.slice(1)} plan`}
          </p>
        </div>

        {/* Amount */}
        <AmountDisplay
          amount={price}
          token={selectedToken}
          chain={selectedChain}
        />

        {/* Step 1: Chain */}
        <section className="mt-6">
          <StepHeader step={1} title="Select network" />
          <ChainSelector
            chains={visibleChains}
            selected={selectedChain}
            onSelect={setSelectedChain}
            disabled={verified}
          />
        </section>

        {/* Step 2: Token */}
        <section className="mt-4">
          <StepHeader step={2} title="Select token" />
          <TokenSelector
            tokens={TOKENS}
            selected={selectedToken}
            onSelect={setSelectedToken}
            disabled={verified}
            disabledTokens={
              tokenAddress === "0x" ? [selectedToken] : []
            }
          />
        </section>

        {/* Step 3: Pay */}
        <section className="mt-4">
          <StepHeader step={3} title="Send payment" />
          <div className="rounded-xl border border-border bg-surface p-4">
            {/* Wallet connect + send */}
            <WalletConnect
              chain={selectedChain}
              token={selectedToken}
              tokenAddress={tokenAddress}
              walletAddress={walletAddress}
              amount={price}
              onTxSent={handleTxSent}
              beforeSend={beforeSend}
              disabled={verified || submitting || isUnknownTopup || invalidSignedLink}
              onStatus={(type, msg) => setStatus({ type, message: msg })}
            />
          </div>
        </section>

        {/* Status */}
        {(isUnknownTopup || status) && (
          <div className="mt-4">
            <StatusMessage
              type={isUnknownTopup ? "error" : status!.type}
              message={isUnknownTopup ? `Unknown top-up pack: ${topup}` : status!.message}
            />
          </div>
        )}

        {/* Footer */}
        <p className="mt-8 text-center text-xs text-muted/50">
          Powered by OpenClaw
        </p>
      </div>
    </main>
  );
}

function StepHeader({ step, title }: { step: number; title: string }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-xs font-bold text-white">
        {step}
      </span>
      <span className="text-sm font-medium">{title}</span>
    </div>
  );
}
