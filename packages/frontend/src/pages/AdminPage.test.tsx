import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import AdminPage from "./AdminPage";

// Mock api/client
vi.mock("../api/client", () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));

import { get } from "../api/client";
const mockGet = vi.mocked(get);

beforeEach(() => {
  vi.clearAllMocks();
});

function setupAdminMocks() {
  mockGet.mockImplementation((path: string) => {
    if (path === "/api/auth/me") {
      return Promise.resolve({
        user: { id: "1", email: "admin@example.com", is_admin: true },
      });
    }
    if (path.startsWith("/api/admin/users") && !path.includes("/api/admin/users/")) {
      return Promise.resolve({
        users: [
          {
            id: "user-1",
            email: "alice@example.com",
            status: "active",
            planId: "payg",
            balanceCents: 5000,
            createdAt: "2025-01-01T00:00:00Z",
            isAdmin: false,
          },
          {
            id: "user-2",
            email: "bob@example.com",
            status: "suspended",
            planId: "free",
            balanceCents: 0,
            createdAt: "2025-01-02T00:00:00Z",
            isAdmin: false,
          },
        ],
        pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
      });
    }
    if (path.startsWith("/api/admin/revenue/daily")) {
      return Promise.resolve({
        days: [
          { date: "2025-01-01", revenueCents: 2500, revenueUsd: 25.0, transactionCount: 2 },
        ],
        period: { since: "2025-01-01", until: "2025-01-31" },
      });
    }
    if (path.startsWith("/api/admin/revenue")) {
      return Promise.resolve({
        totalRevenueCents: 10000,
        totalRevenueUsd: 100.0,
        totalTransactions: 10,
        avgTransactionCents: 1000,
        avgTransactionUsd: 10.0,
        topUpCount: 10,
        uniquePayingUsers: 5,
        period: { since: "2025-01-01", until: "2025-01-31" },
      });
    }
    if (path === "/api/admin/stats") {
      return Promise.resolve({
        totalUsers: 100,
        activeUsers: 80,
        suspendedUsers: 5,
        totalApiKeys: 150,
        activeApiKeys: 120,
        totalSessions: 500,
        activeSessions: 25,
      });
    }
    return Promise.reject(new Error(`Unexpected get: ${path}`));
  });
}

function setupNonAdminMocks() {
  mockGet.mockImplementation((path: string) => {
    if (path === "/api/auth/me") {
      return Promise.resolve({
        user: { id: "2", email: "user@example.com", is_admin: false },
      });
    }
    return Promise.reject(new Error(`Unexpected get: ${path}`));
  });
}

function renderAdminPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <AdminPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("AdminPage", () => {
  it("shows Access Denied for non-admin users", async () => {
    setupNonAdminMocks();
    renderAdminPage();

    await waitFor(() => {
      expect(screen.getByText("Access Denied")).toBeInTheDocument();
    });

    expect(screen.getByText("You do not have admin privileges.")).toBeInTheDocument();
  });

  it("renders Admin Dashboard heading for admin users", async () => {
    setupAdminMocks();
    renderAdminPage();

    await waitFor(() => {
      expect(screen.getByText("Admin Dashboard")).toBeInTheDocument();
    });

    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("renders tab navigation with Users, Revenue, and System tabs", async () => {
    setupAdminMocks();
    renderAdminPage();

    await waitFor(() => {
      expect(screen.getByText("Users")).toBeInTheDocument();
    });

    expect(screen.getByText("Revenue")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
  });

  it("renders the users table with user data on Users tab", async () => {
    setupAdminMocks();
    renderAdminPage();

    await waitFor(() => {
      // ResponsiveTable renders desktop+mobile views; text may appear in both
      expect(screen.getAllByText("alice@example.com").length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText("bob@example.com").length).toBeGreaterThan(0);

    // Table headers
    expect(screen.getAllByText("Email").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Status").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Plan").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Balance").length).toBeGreaterThan(0);
  });

  it("shows user action buttons (Suspend, Activate, Delete)", async () => {
    setupAdminMocks();
    renderAdminPage();

    await waitFor(() => {
      expect(screen.getAllByText("alice@example.com").length).toBeGreaterThan(0);
    });

    // Alice is active -> should have Suspend button
    const suspendButtons = screen.getAllByText("Suspend");
    expect(suspendButtons.length).toBeGreaterThan(0);

    // Bob is suspended -> should have Activate button
    const activateButtons = screen.getAllByText("Activate");
    expect(activateButtons.length).toBeGreaterThan(0);
  });

  it("switches to Revenue tab and shows revenue data", async () => {
    setupAdminMocks();
    renderAdminPage();

    await waitFor(() => {
      expect(screen.getByText("Admin Dashboard")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Revenue"));

    await waitFor(() => {
      expect(screen.getByText("Total Revenue")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("$100.00")).toBeInTheDocument();
    });

    expect(screen.getByText("Transactions")).toBeInTheDocument();
    expect(screen.getByText("Unique Payers")).toBeInTheDocument();
  });

  it("switches to System tab and shows system stats", async () => {
    setupAdminMocks();
    renderAdminPage();

    await waitFor(() => {
      expect(screen.getByText("Admin Dashboard")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("System"));

    await waitFor(() => {
      expect(screen.getByText("Total Users")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("100")).toBeInTheDocument();
    });

    expect(screen.getByText("Active Users")).toBeInTheDocument();
    expect(screen.getByText("Suspended Users")).toBeInTheDocument();
    expect(screen.getByText("Active API Keys")).toBeInTheDocument();
    expect(screen.getByText("Active Sessions")).toBeInTheDocument();
  });
});
