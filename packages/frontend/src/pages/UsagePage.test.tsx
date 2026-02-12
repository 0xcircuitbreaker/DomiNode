import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test-utils";
import UsagePage from "./UsagePage";

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
  mockGet.mockImplementation((path: string) => {
    if (path === "/api/auth/me") {
      return Promise.resolve({
        user: { id: "1", email: "test@example.com", is_admin: false },
      });
    }
    if (path.startsWith("/api/usage/daily")) {
      return Promise.resolve({
        days: [
          { date: "2025-01-01", totalGB: 0.5, totalCostUsd: 2.5, requestCount: 50 },
          { date: "2025-01-02", totalGB: 0.3, totalCostUsd: 1.5, requestCount: 30 },
        ],
      });
    }
    if (path.startsWith("/api/usage/top-hosts")) {
      return Promise.resolve({
        hosts: [
          { host: "httpbin.org", totalBytes: 524288, requestCount: 10 },
        ],
      });
    }
    if (path.startsWith("/api/usage")) {
      return Promise.resolve({
        summary: {
          totalBytes: 858993459,
          totalCostCents: 400,
          requestCount: 80,
          totalGB: 0.8,
          totalCostUsd: 4.0,
        },
        records: [
          {
            id: "rec-1",
            sessionId: "sess-1",
            bytesIn: 1024,
            bytesOut: 2048,
            totalBytes: 3072,
            costCents: 2,
            proxyType: "http",
            targetHost: "example.com",
            createdAt: "2025-01-01T12:00:00Z",
          },
        ],
        pagination: { limit: 50, offset: 0, total: 1 },
        period: { since: "2025-01-01T00:00:00Z", until: "2025-01-31T23:59:59Z" },
      });
    }
    return Promise.reject(new Error(`Unexpected get: ${path}`));
  });
}

describe("UsagePage", () => {
  it("renders the Usage heading", async () => {
    setupMocks();
    renderWithProviders(<UsagePage />);

    await waitFor(() => {
      expect(screen.getByText("Usage")).toBeInTheDocument();
    });
  });

  it("renders summary cards with total data, cost, and requests", async () => {
    setupMocks();
    renderWithProviders(<UsagePage />);

    await waitFor(() => {
      expect(screen.getByText("Total Data")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("0.800 GB")).toBeInTheDocument();
    });

    expect(screen.getByText("Total Cost")).toBeInTheDocument();
    expect(screen.getByText("$4.00")).toBeInTheDocument();
    expect(screen.getByText("Requests")).toBeInTheDocument();
  });

  it("renders date range inputs", async () => {
    setupMocks();
    renderWithProviders(<UsagePage />);

    await waitFor(() => {
      expect(screen.getByText("From")).toBeInTheDocument();
    });

    expect(screen.getByText("To")).toBeInTheDocument();
    expect(screen.getByText("Apply")).toBeInTheDocument();
  });

  it("renders usage records table with target host", async () => {
    setupMocks();
    renderWithProviders(<UsagePage />);

    await waitFor(() => {
      expect(screen.getByText("example.com")).toBeInTheDocument();
    });

    // Table headers
    expect(screen.getByText("Target")).toBeInTheDocument();
    expect(screen.getByText("Upload")).toBeInTheDocument();
    expect(screen.getByText("Download")).toBeInTheDocument();
  });

  it("renders chart metric buttons", async () => {
    setupMocks();
    renderWithProviders(<UsagePage />);

    await waitFor(() => {
      expect(screen.getByText("Daily Breakdown")).toBeInTheDocument();
    });

    expect(screen.getByText("bandwidth")).toBeInTheDocument();
    expect(screen.getByText("cost")).toBeInTheDocument();
    expect(screen.getByText("requests")).toBeInTheDocument();
  });
});
