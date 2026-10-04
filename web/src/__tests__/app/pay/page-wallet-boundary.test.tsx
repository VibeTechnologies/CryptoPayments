// Pay page tests at the WALLET-SEND boundary: the real WalletConnect component
// is rendered and only the wallet library (sendEvmTransfer) is mocked. These
// prove a bad signed link never initiates an on-chain transfer — asserting on
// onTxSent/submitPayment alone would miss a transfer that was already mined.
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/api", () => ({
  fetchConfig: vi.fn(),
  submitPayment: vi.fn(),
  checkPaymentStatus: vi.fn(),
}));

// Pass-through to the real intent contract. `tamper.on` makes ONLY the page's
// own buildPaymentBodyFromIntent calls (not the module-internal ones used by
// findInvalidSignedIntentParams) override the plan with "starter", simulating a
// body regression so the send-boundary parity guard can be exercised for real.
const tamper = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/intent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/intent")>();
  return {
    ...actual,
    buildPaymentBodyFromIntent: (params: URLSearchParams) => {
      const body = actual.buildPaymentBodyFromIntent(params);
      return tamper.on ? { ...body, plan: "starter" } : body;
    },
  };
});

vi.mock("@/lib/wallets/evm", () => ({
  isEvmAvailable: vi.fn(() => true),
  connectEvm: vi.fn(),
  connectEvmCoinbase: vi.fn(),
  connectEvmWalletConnect: vi.fn(),
  sendEvmTransfer: vi.fn(),
}));

vi.mock("@/lib/wallets/solana", () => ({
  isSolanaAvailable: vi.fn(() => false),
  connectSolana: vi.fn(),
  sendSolanaTransfer: vi.fn(),
}));

vi.mock("@/lib/wallets/ton", () => ({
  buildTonTransferMessage: vi.fn(),
}));

vi.mock("@tonconnect/ui-react", () => ({
  useTonConnectUI: () => [{ openModal: vi.fn(), sendTransaction: vi.fn() }, vi.fn()],
  useTonAddress: () => "",
  TonConnectUIProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { fetchConfig, submitPayment } from "@/lib/api";
import { connectEvm, sendEvmTransfer } from "@/lib/wallets/evm";
import { SEND_MIN_REMAINING_SEC } from "@/lib/intent";
import PayPage from "@/app/pay/page";

const mockConfig = {
  wallets: { base: "0xBaseWallet", eth: "0xEthWallet", sol: "Sol", ton: "Ton", base_sepolia: "0x1", eth_sepolia: "0x2" },
  prices: { starter: 10, pro: 25, max: 100 },
  tokens: {
    base: { usdc: "0xBaseUSDC", usdt: "0xBaseUSDT" },
    eth: { usdc: "0xEthUSDC", usdt: "0xEthUSDT" },
    sol: { usdc: "SolUSDC", usdt: "SolUSDT" },
    ton: { usdc: "TonUSDC", usdt: "TonUSDT" },
    base_sepolia: { usdc: "0xSepoliaUSDC", usdt: "0x" },
    eth_sepolia: { usdc: "0x", usdt: "0x", ausd: "0xA" },
  },
  chains: ["base", "eth", "sol", "ton", "base_sepolia", "eth_sepolia"],
};

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const INVALID_LINK = "This payment link is invalid or was modified. Request a new link.";
const EXPIRED_LINK = "This payment link has expired. Request a new link.";
const EXPIRING_LINK = "This payment link expires too soon to complete a payment. Request a new link.";
const UID_MISMATCH =
  "This payment link was issued for a different Telegram account. Open it from the account that requested it.";

function setUrlParams(params: Record<string, string>) {
  const url = new URL("http://localhost/pay");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  Object.defineProperty(window, "location", {
    value: { ...window.location, search: url.search, href: url.href },
    writable: true,
    configurable: true,
  });
}

function mockTelegramUser(id: number) {
  window.Telegram = {
    WebApp: {
      ready: vi.fn(),
      expand: vi.fn(),
      close: vi.fn(),
      initData: "signed_tg_init_data",
      initDataUnsafe: { user: { id, first_name: "Alice" } },
    },
  };
}

function signedParams(exp: string): Record<string, string> {
  return {
    plan: "max",
    uid: "12345",
    idtype: "tg",
    amountUsd: "100.00",
    exp,
    tenantType: "team",
    tenant: "team",
    vmp: "lxd",
    hostType: "vps",
    deploymentType: "hermes",
    sig: "abc123",
  };
}

async function connectAndClickPay(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(screen.getByTitle("Connect browser wallet")).toBeInTheDocument());
  await user.click(screen.getByTitle("Connect browser wallet"));
}

describe("PayPage wallet-send boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tamper.on = false;
    (window as unknown as { Telegram?: unknown }).Telegram = undefined;
    vi.mocked(fetchConfig).mockResolvedValue(mockConfig as never);
    vi.mocked(connectEvm).mockResolvedValue({ signer: {} as never, address: ADDRESS });
    vi.mocked(sendEvmTransfer).mockResolvedValue("0xmined");
    vi.mocked(submitPayment).mockResolvedValue({ payment: { status: "verified", id: "p1" } } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("control: a valid signed link reaches the wallet transfer", async () => {
    const user = userEvent.setup();
    setUrlParams(signedParams("9999999999"));
    mockTelegramUser(12345);
    render(<PayPage />);
    await connectAndClickPay(user);
    const pay = await screen.findByRole("button", { name: /Pay \$100\.00/ });
    expect(pay).not.toBeDisabled();
    await user.click(pay);
    await waitFor(() => expect(sendEvmTransfer).toHaveBeenCalledTimes(1));
  });

  it("signed uid != Telegram user id: error shown, transfer never initiated", async () => {
    const user = userEvent.setup();
    setUrlParams(signedParams("9999999999"));
    mockTelegramUser(99999);
    render(<PayPage />);
    await waitFor(() => expect(screen.getByText(UID_MISMATCH)).toBeInTheDocument());
    const connect = screen.getByTitle("Connect browser wallet");
    expect(connect).toBeDisabled();
    await user.click(connect);
    expect(screen.queryByRole("button", { name: /Pay \$/ })).not.toBeInTheDocument();
    expect(sendEvmTransfer).not.toHaveBeenCalled();
    expect(submitPayment).not.toHaveBeenCalled();
  });

  it("already-expired signed link: blocked at mount, transfer never initiated", async () => {
    const user = userEvent.setup();
    setUrlParams(signedParams(String(Math.floor(Date.now() / 1000) - 10)));
    render(<PayPage />);
    await waitFor(() => expect(screen.getByText(EXPIRED_LINK)).toBeInTheDocument());
    await user.click(screen.getByTitle("Connect browser wallet"));
    expect(sendEvmTransfer).not.toHaveBeenCalled();
    expect(submitPayment).not.toHaveBeenCalled();
  });

  it("empty sig: blocked at mount, transfer never initiated", async () => {
    const user = userEvent.setup();
    setUrlParams({ ...signedParams("9999999999"), sig: "" });
    render(<PayPage />);
    await waitFor(() => expect(screen.getByText(INVALID_LINK)).toBeInTheDocument());
    await user.click(screen.getByTitle("Connect browser wallet"));
    expect(sendEvmTransfer).not.toHaveBeenCalled();
    expect(submitPayment).not.toHaveBeenCalled();
  });

  // Minimal signed URL (plan + explicit amount + callback).
  function minimalSignedParams(): Record<string, string> {
    return {
      plan: "pro",
      uid: "12345",
      idtype: "tg",
      exp: "9999999999",
      amountUsd: "42.00",
      callback: "https://admin.openclaw.vibebrowser.app/webhook",
      sig: "abc123",
    };
  }

  it("minimal signed URL: POST carries ONLY the URL-derived signed fields plus transport", async () => {
    const user = userEvent.setup();
    setUrlParams(minimalSignedParams());
    mockTelegramUser(12345);
    render(<PayPage />);
    await connectAndClickPay(user);
    await user.click(await screen.findByRole("button", { name: /Pay \$42\.00/ }));
    await waitFor(() => expect(sendEvmTransfer).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(submitPayment).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(submitPayment).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(sent).not.toHaveProperty("topup");
    const defined = Object.fromEntries(Object.entries(sent).filter(([, v]) => v !== undefined));
    expect(defined).toEqual({
      txHash: "0xmined",
      chainId: "base",
      token: "usdc",
      initData: "signed_tg_init_data",
      plan: "pro",
      uid: "12345",
      idType: "tg",
      exp: "9999999999",
      amountUsd: "42.00",
      callbackUrl: "https://admin.openclaw.vibebrowser.app/webhook",
      sig: "abc123",
    });
  });

  // #58 r6: a signed intent naming no product (no plan, no topup) cannot be
  // settled by the server, so it must be rejected BEFORE the transfer.
  it("signed URL with neither plan nor topup: invalid link, no wallet transfer, no POST", async () => {
    const user = userEvent.setup();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { plan: _plan, ...planless } = minimalSignedParams();
    setUrlParams(planless);
    mockTelegramUser(12345);
    render(<PayPage />);
    await waitFor(() => expect(screen.getByText(INVALID_LINK)).toBeInTheDocument());
    const connect = screen.getByTitle("Connect browser wallet");
    expect(connect).toBeDisabled();
    await user.click(connect);
    expect(screen.queryByRole("button", { name: /Pay \$/ })).not.toBeInTheDocument();
    expect(sendEvmTransfer).not.toHaveBeenCalled();
    expect(submitPayment).not.toHaveBeenCalled();
  });

  // #58 r6: unknown (unsigned, non-UI) keys on a signed link fail closed.
  it("signed URL with an unknown key (nonce): invalid link, no wallet transfer, no POST", async () => {
    const user = userEvent.setup();
    setUrlParams({
      uid: "42",
      idtype: "tg",
      exp: String(Math.floor(Date.now() / 1000) + 3600),
      plan: "max",
      vmp: "lxd",
      hostType: "vps",
      deploymentType: "hermes",
      nonce: "123",
      sig: "x",
    });
    mockTelegramUser(42);
    render(<PayPage />);
    await waitFor(() => expect(screen.getByText(INVALID_LINK)).toBeInTheDocument());
    const connect = screen.getByTitle("Connect browser wallet");
    expect(connect).toBeDisabled();
    await user.click(connect);
    expect(screen.queryByRole("button", { name: /Pay \$/ })).not.toBeInTheDocument();
    expect(sendEvmTransfer).not.toHaveBeenCalled();
    expect(submitPayment).not.toHaveBeenCalled();
  });

  it("signed URL with the allowlisted UI key test=true still reaches the transfer", async () => {
    const user = userEvent.setup();
    setUrlParams({ ...minimalSignedParams(), test: "true" });
    mockTelegramUser(12345);
    render(<PayPage />);
    await connectAndClickPay(user);
    await user.click(await screen.findByRole("button", { name: /Pay \$42\.00/ }));
    await waitFor(() => expect(sendEvmTransfer).toHaveBeenCalledTimes(1));
  });

  // #58 r6: unsigned link — the POSTed plan must equal the displayed/charged
  // plan. Telegram start_param `pro_42` overrides `?plan=starter`.
  it("unsigned ?plan=starter + start_param pro_42: transfers the pro price and POSTs plan=pro", async () => {
    const user = userEvent.setup();
    setUrlParams({ plan: "starter" });
    window.Telegram = {
      WebApp: {
        ready: vi.fn(),
        expand: vi.fn(),
        close: vi.fn(),
        initData: "signed_tg_init_data",
        initDataUnsafe: { user: { id: 42, first_name: "Alice" }, start_param: "pro_42" },
      },
    };
    render(<PayPage />);
    await waitFor(() => expect(screen.getByText(/Pro plan/)).toBeInTheDocument());
    await connectAndClickPay(user);
    await user.click(await screen.findByRole("button", { name: /Pay \$25\.00/ }));
    await waitFor(() => expect(sendEvmTransfer).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendEvmTransfer).mock.calls[0][3]).toBe(25);
    await waitFor(() => expect(submitPayment).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(submitPayment).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(sent.plan).toBe("pro");
    expect(sent.uid).toBe("42");
    expect(sent.idType).toBe("tg");
  });

  it("parity guard: if the signed POST body would differ from the URL, the real wallet send is blocked", async () => {
    const user = userEvent.setup();
    setUrlParams(minimalSignedParams());
    mockTelegramUser(12345);
    render(<PayPage />);
    await connectAndClickPay(user);
    const pay = await screen.findByRole("button", { name: /Pay \$42\.00/ });
    expect(pay).not.toBeDisabled();

    // The body builder now rewrites plan to "starter" (URL signed plan=pro).
    tamper.on = true;
    await user.click(pay);

    await waitFor(() => expect(screen.getByText(INVALID_LINK)).toBeInTheDocument());
    expect(sendEvmTransfer).not.toHaveBeenCalled();
    expect(submitPayment).not.toHaveBeenCalled();
  });

  it("exp of 310 nines (non-finite): invalid link, transfer never initiated", async () => {
    const user = userEvent.setup();
    setUrlParams({ ...minimalSignedParams(), exp: "9".repeat(310) });
    mockTelegramUser(12345);
    render(<PayPage />);
    await waitFor(() => expect(screen.getByText(INVALID_LINK)).toBeInTheDocument());
    expect(screen.queryByText(EXPIRED_LINK)).not.toBeInTheDocument();
    await user.click(screen.getByTitle("Connect browser wallet"));
    expect(screen.queryByRole("button", { name: /Pay \$/ })).not.toBeInTheDocument();
    expect(sendEvmTransfer).not.toHaveBeenCalled();
    expect(submitPayment).not.toHaveBeenCalled();
  });

  it("link expires while the page is open: exp re-checked before transfer, send aborted", async () => {
    const user = userEvent.setup();
    const realNow = Date.now();
    const exp = Math.floor(realNow / 1000) + 3600;
    setUrlParams(signedParams(String(exp)));
    mockTelegramUser(12345);
    render(<PayPage />);
    await connectAndClickPay(user);
    const pay = await screen.findByRole("button", { name: /Pay \$100\.00/ });
    expect(pay).not.toBeDisabled();

    // Time passes past exp before the user clicks Pay.
    vi.spyOn(Date, "now").mockReturnValue((exp + 1) * 1000);
    await user.click(pay);

    await waitFor(() => expect(screen.getByText(EXPIRED_LINK)).toBeInTheDocument());
    expect(sendEvmTransfer).not.toHaveBeenCalled();
    expect(submitPayment).not.toHaveBeenCalled();
  });

  describe("send window (fake timers): no send unless exp - now >= SEND_MIN_REMAINING_SEC", () => {
    const T0 = Date.UTC(2030, 0, 1) ; // ms
    const t0 = Math.floor(T0 / 1000);

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
      vi.setSystemTime(T0);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("SEND_MIN_REMAINING_SEC is 300", () => {
      expect(SEND_MIN_REMAINING_SEC).toBe(300);
    });

    it("clock reaches exp - 200s before Pay: send refused, no transfer, no POST", async () => {
      const user = userEvent.setup();
      const exp = t0 + 3600;
      setUrlParams(signedParams(String(exp)));
      mockTelegramUser(12345);
      render(<PayPage />);
      await connectAndClickPay(user);
      const pay = await screen.findByRole("button", { name: /Pay \$100\.00/ });
      expect(pay).not.toBeDisabled();

      vi.setSystemTime((exp - 200) * 1000);
      await user.click(pay);

      await waitFor(() => expect(screen.getByText(EXPIRING_LINK)).toBeInTheDocument());
      expect(sendEvmTransfer).not.toHaveBeenCalled();
      expect(submitPayment).not.toHaveBeenCalled();
    });

    it("exp - 200s already at mount: blocked, no transfer, no POST", async () => {
      const user = userEvent.setup();
      setUrlParams(signedParams(String(t0 + 200)));
      mockTelegramUser(12345);
      render(<PayPage />);
      await waitFor(() => expect(screen.getByText(EXPIRING_LINK)).toBeInTheDocument());
      await user.click(screen.getByTitle("Connect browser wallet"));
      expect(screen.queryByRole("button", { name: /Pay \$/ })).not.toBeInTheDocument();
      expect(sendEvmTransfer).not.toHaveBeenCalled();
      expect(submitPayment).not.toHaveBeenCalled();
    });

    it("control: exp - 305s at click (>= 300s left) still sends", async () => {
      const user = userEvent.setup();
      const exp = t0 + 3600;
      setUrlParams(signedParams(String(exp)));
      mockTelegramUser(12345);
      render(<PayPage />);
      await connectAndClickPay(user);
      const pay = await screen.findByRole("button", { name: /Pay \$100\.00/ });
      vi.setSystemTime((exp - 305) * 1000);
      await user.click(pay);
      await waitFor(() => expect(sendEvmTransfer).toHaveBeenCalledTimes(1));
    });
  });
});
