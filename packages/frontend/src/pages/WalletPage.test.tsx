import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test-utils";
import WalletPage from "./WalletPage";

// Mock api/client
vi.mock("../api/client", () => ({
  get: vi.fn(),
  post: vi.fn(),
}));

import { get } from "../api/client";
const mockGet = vi.mocked(get);

beforeEach(() => {
  vi.clearAllMocks();
});

function setupMocks(opts?: {
  balanceCents?: number;
  transactions?: Array<{
    id: string;
    type: string;
    amountCents: number;
    amountUsd: number;
    description: string;
    paymentProvider: string | null;
    createdAt: string;
  }>;
}) {
  const { balanceCents = 5000, transactions = [] } = opts ?? {};

  mockGet.mockImplementation((path: string) => {
    if (path === "/api/auth/me") {
      return Promise.resolve({
        user: { id: "1", email: "test@example.com", is_admin: false },
      });
    }
    if (path === "/api/wallet") {
      return Promise.resolve({
        balanceCents,
        balanceUsd: balanceCents / 100,
        lastToppedUp: "2025-01-15T00:00:00Z",
      });
    }
    if (path === "/api/wallet/transactions") {
      return Promise.resolve({ transactions });
    }
    if (path === "/api/plans/user/plan") {
      return Promise.resolve({
        plan: {
          id: "payg",
          name: "Pay As You Go",
          pricePerGbCents: 500,
          pricePerGbUsd: 5.0,
        },
      });
    }
    if (path === "/api/wallet/forecast") {
      return Promise.resolve({
        dailyAvgCents: 200,
        daysRemaining: 25,
        trend: "stable",
        trendPct: 5,
      });
    }
    return Promise.reject(new Error(`Unexpected get: ${path}`));
  });
}

describe("WalletPage", () => {
  it("renders the Wallet heading", async () => {
    setupMocks();
    renderWithProviders(<WalletPage />);

    await waitFor(() => {
      expect(screen.getByText("Wallet")).toBeInTheDocument();
    });
  });

  it("displays the current balance", async () => {
    setupMocks({ balanceCents: 10000 });
    renderWithProviders(<WalletPage />);

    await waitFor(() => {
      expect(screen.getByText("Current Balance")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("$100.00")).toBeInTheDocument();
    });
  });

  it("renders top-up section with preset amounts", async () => {
    setupMocks();
    renderWithProviders(<WalletPage />);

    await waitFor(() => {
      expect(screen.getByText("Top Up")).toBeInTheDocument();
    });

    // Check preset amount buttons
    expect(screen.getByText("$5")).toBeInTheDocument();
    expect(screen.getByText("$10")).toBeInTheDocument();
    expect(screen.getByText("$25")).toBeInTheDocument();
    expect(screen.getByText("$50")).toBeInTheDocument();
    expect(screen.getByText("$100")).toBeInTheDocument();
  });

  it("renders Stripe and crypto payment options", async () => {
    setupMocks();
    renderWithProviders(<WalletPage />);

    await waitFor(() => {
      expect(screen.getByText("Card Payment (Stripe)")).toBeInTheDocument();
    });

    expect(screen.getByText("Crypto Payment")).toBeInTheDocument();
    // Check crypto options
    expect(screen.getByText("btc")).toBeInTheDocument();
    expect(screen.getByText("eth")).toBeInTheDocument();
    expect(screen.getByText("xmr")).toBeInTheDocument();
    expect(screen.getByText("sol")).toBeInTheDocument();
    expect(screen.getByText("zec")).toBeInTheDocument();
  });

  it("shows empty transactions message when no transactions exist", async () => {
    setupMocks({ transactions: [] });
    renderWithProviders(<WalletPage />);

    await waitFor(() => {
      // ResponsiveTable renders desktop+mobile views; text may appear in both
      expect(screen.getAllByText("No transactions yet.").length).toBeGreaterThan(0);
    });
  });

  it("renders transactions when they exist", async () => {
    setupMocks({
      transactions: [
        {
          id: "tx-1",
          type: "topup",
          amountCents: 2500,
          amountUsd: 25.0,
          description: "Stripe top-up",
          paymentProvider: "stripe",
          createdAt: "2025-01-15T00:00:00Z",
        },
        {
          id: "tx-2",
          type: "debit",
          amountCents: 350,
          amountUsd: 3.5,
          description: "Usage charge",
          paymentProvider: null,
          createdAt: "2025-01-16T00:00:00Z",
        },
      ],
    });

    renderWithProviders(<WalletPage />);

    await waitFor(() => {
      expect(screen.getByText("Transaction History")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getAllByText("Stripe top-up").length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText("Usage charge").length).toBeGreaterThan(0);
    expect(screen.getAllByText("+$25.00").length).toBeGreaterThan(0);
  });
});
