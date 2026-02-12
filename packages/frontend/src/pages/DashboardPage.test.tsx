import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test-utils";
import DashboardPage from "./DashboardPage";

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

function setupMocks() {
  // /api/auth/me - user is logged in
  mockGet.mockImplementation((path: string) => {
    if (path === "/api/auth/me") {
      return Promise.resolve({
        user: { id: "1", email: "test@example.com", is_admin: false },
      });
    }
    if (path === "/api/wallet") {
      return Promise.resolve({ balanceCents: 5000, balanceUsd: 50.0 });
    }
    if (path === "/api/usage") {
      return Promise.resolve({
        summary: {
          totalBytes: 1073741824,
          totalCostCents: 700,
          requestCount: 150,
          totalGB: 1.0,
          totalCostUsd: 7.0,
        },
      });
    }
    if (path.startsWith("/api/usage/daily")) {
      return Promise.resolve({
        days: [
          { date: "2025-01-01", totalGB: 0.5, totalCostUsd: 3.5, requestCount: 75 },
          { date: "2025-01-02", totalGB: 0.5, totalCostUsd: 3.5, requestCount: 75 },
        ],
      });
    }
    if (path === "/api/plans/user/plan") {
      return Promise.resolve({
        plan: {
          id: "payg",
          name: "Pay As You Go",
          pricePerGbCents: 500,
          pricePerGbUsd: 5.0,
          monthlyBandwidthBytes: 0,
          monthlyBandwidthGB: null,
          isDefault: true,
        },
        usage: {
          monthlyUsageBytes: 1073741824,
          monthlyUsageGB: 1.0,
          limitBytes: 0,
          limitGB: null,
          percentUsed: null,
        },
      });
    }
    if (path === "/api/proxy/status") {
      return Promise.resolve({
        status: "operational",
        circuitBreaker: "closed",
        activeSessions: 5,
        userActiveSessions: 2,
        avgLatencyMs: 120,
        endpoints: { http: "proxy.dominode.io:8080", socks5: "proxy.dominode.io:1080" },
        uptimeSeconds: 86400,
      });
    }
    if (path === "/api/sessions/active") {
      return Promise.resolve({ sessions: [] });
    }
    return Promise.reject(new Error(`Unexpected get: ${path}`));
  });
}

describe("DashboardPage", () => {
  it("renders Dashboard heading", async () => {
    setupMocks();
    renderWithProviders(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText("Dashboard")).toBeInTheDocument();
    });
  });

  it("renders wallet balance stat card", async () => {
    setupMocks();
    renderWithProviders(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText("Wallet Balance")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("$50.00")).toBeInTheDocument();
    });
  });

  it("renders data used stat card", async () => {
    setupMocks();
    renderWithProviders(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText("Data Used (30 days)")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("1.000 GB")).toBeInTheDocument();
    });
  });

  it("renders total spent stat card", async () => {
    setupMocks();
    renderWithProviders(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText("Total Spent (30 days)")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("$7.00")).toBeInTheDocument();
    });
  });

  it("renders current plan card", async () => {
    setupMocks();
    renderWithProviders(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText("Current Plan")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("Pay As You Go")).toBeInTheDocument();
    });
  });

  it("renders Quick Actions section with links", async () => {
    setupMocks();
    renderWithProviders(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText("Quick Actions")).toBeInTheDocument();
    });

    expect(screen.getByText("Manage API Keys")).toBeInTheDocument();
    expect(screen.getByText("Top Up Wallet")).toBeInTheDocument();
  });

  it("renders proxy status when operational", async () => {
    setupMocks();
    renderWithProviders(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText("Proxy Status")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("Operational")).toBeInTheDocument();
    });
  });
});
