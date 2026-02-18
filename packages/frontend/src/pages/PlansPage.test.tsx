import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test-utils";
import PlansPage from "./PlansPage";

// Mock api/client
vi.mock("../api/client", () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

import { get } from "../api/client";
const mockGet = vi.mocked(get);

beforeEach(() => {
  vi.clearAllMocks();
});

const mockPlans = [
  {
    id: "free-dc",
    name: "Free DC",
    pricePerGbCents: 0,
    pricePerGbUsd: 0,
    monthlyBandwidthBytes: 2147483648,
    monthlyBandwidthGB: 2,
    isDefault: true,
    maxConnections: 5,
    allowedProxyTypes: "dc",
  },
  {
    id: "free-res",
    name: "Free Residential",
    pricePerGbCents: 0,
    pricePerGbUsd: 0,
    monthlyBandwidthBytes: 52428800,
    monthlyBandwidthGB: 0.05,
    isDefault: false,
    maxConnections: 5,
    allowedProxyTypes: "residential",
  },
  {
    id: "payg",
    name: "Pay As You Go",
    pricePerGbCents: 500,
    pricePerGbUsd: 5.0,
    monthlyBandwidthBytes: 0,
    monthlyBandwidthGB: null,
    isDefault: false,
    maxConnections: 100,
    allowedProxyTypes: null,
  },
  {
    id: "vol100",
    name: "Volume 100",
    pricePerGbCents: 400,
    pricePerGbUsd: 4.0,
    monthlyBandwidthBytes: 107374182400,
    monthlyBandwidthGB: 100,
    isDefault: false,
    maxConnections: 100,
    allowedProxyTypes: null,
  },
  {
    id: "vol1000",
    name: "Volume 1000",
    pricePerGbCents: 300,
    pricePerGbUsd: 3.0,
    monthlyBandwidthBytes: 1073741824000,
    monthlyBandwidthGB: 1000,
    isDefault: false,
    maxConnections: 100,
    allowedProxyTypes: null,
  },
];

function setupMocks() {
  mockGet.mockImplementation((path: string) => {
    if (path === "/api/auth/me") {
      return Promise.resolve({
        user: { id: "1", email: "test@example.com", is_admin: false },
      });
    }
    if (path === "/api/plans") {
      return Promise.resolve({ plans: mockPlans });
    }
    if (path === "/api/plans/user/plan") {
      return Promise.resolve({
        plan: mockPlans[2], // payg
        usage: {
          monthlyUsageBytes: 536870912,
          monthlyUsageGB: 0.5,
          limitBytes: 0,
          limitGB: null,
          percentUsed: null,
        },
      });
    }
    return Promise.reject(new Error(`Unexpected get: ${path}`));
  });
}

describe("PlansPage", () => {
  it("renders the Plans heading", async () => {
    setupMocks();
    renderWithProviders(<PlansPage />);

    await waitFor(() => {
      expect(screen.getByText("Plans")).toBeInTheDocument();
    });
  });

  it("renders current plan name", async () => {
    setupMocks();
    renderWithProviders(<PlansPage />);

    await waitFor(() => {
      expect(screen.getAllByText(/Current Plan/).length).toBeGreaterThan(0);
    });

    await waitFor(() => {
      // Pay As You Go appears in the current plan display AND the plan card grid AND the table
      expect(screen.getAllByText("Pay As You Go").length).toBeGreaterThan(0);
    });
  });

  it("renders all available plan cards", async () => {
    setupMocks();
    renderWithProviders(<PlansPage />);

    // Each plan name appears in both the card grid and the details table, so use getAllByText
    await waitFor(() => {
      expect(screen.getAllByText("Free DC").length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText("Free Residential").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pay As You Go").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Volume 100").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Volume 1000").length).toBeGreaterThan(0);
  });

  it("shows the current plan badge on the active plan card", async () => {
    setupMocks();
    renderWithProviders(<PlansPage />);

    // Wait for plans to load, then check for "Current" button on the active plan
    await waitFor(() => {
      expect(screen.getByText("Current")).toBeInTheDocument();
    });
  });

  it("renders plan details comparison table", async () => {
    setupMocks();
    renderWithProviders(<PlansPage />);

    await waitFor(() => {
      expect(screen.getByText("Plan Details")).toBeInTheDocument();
    });

    // ResponsiveTable renders desktop+mobile views; headers may appear in both
    expect(screen.getAllByText("Price/GB").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Monthly Bandwidth").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Savings").length).toBeGreaterThan(0);
  });

  it("displays monthly usage information", async () => {
    setupMocks();
    renderWithProviders(<PlansPage />);

    await waitFor(() => {
      expect(screen.getByText("Monthly Usage")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText(/0\.500 GB/)).toBeInTheDocument();
    });
  });
});
