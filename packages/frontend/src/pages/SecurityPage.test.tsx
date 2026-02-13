import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import SecurityPage from "./SecurityPage";

// Mock api/client
vi.mock("../api/client", () => ({
  get: vi.fn(),
  post: vi.fn(),
}));

import { get, post } from "../api/client";
const mockGet = vi.mocked(get);
const mockPost = vi.mocked(post);

beforeEach(() => {
  vi.clearAllMocks();
});

function setupMocks(mfaEnabled = false, backupCodesRemaining = 10) {
  mockGet.mockImplementation((path: string) => {
    if (path === "/api/auth/me") {
      return Promise.resolve({
        user: { id: "1", email: "test@example.com", is_admin: false },
      });
    }
    if (path === "/api/auth/mfa/status") {
      return Promise.resolve({
        enabled: mfaEnabled,
        backupCodesRemaining,
      });
    }
    return Promise.reject(new Error(`Unexpected get: ${path}`));
  });
}

describe("SecurityPage", () => {
  it("renders the Security heading", async () => {
    setupMocks();
    renderWithProviders(<SecurityPage />);

    await waitFor(() => {
      expect(screen.getByText("Security")).toBeInTheDocument();
    });
  });

  it("shows Two-Factor Authentication section", async () => {
    setupMocks();
    renderWithProviders(<SecurityPage />);

    await waitFor(() => {
      expect(screen.getByText("Two-Factor Authentication")).toBeInTheDocument();
    });

    expect(
      screen.getByText(/Add an extra layer of security/),
    ).toBeInTheDocument();
  });

  it("shows Disabled badge when MFA is off", async () => {
    setupMocks(false);
    renderWithProviders(<SecurityPage />);

    await waitFor(() => {
      expect(screen.getByText("Disabled")).toBeInTheDocument();
    });

    expect(screen.getByText("Set Up 2FA")).toBeInTheDocument();
  });

  it("shows Enabled badge and backup codes remaining when MFA is on", async () => {
    setupMocks(true, 8);
    renderWithProviders(<SecurityPage />);

    await waitFor(() => {
      expect(screen.getByText("Enabled")).toBeInTheDocument();
    });

    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText(/Backup codes remaining/)).toBeInTheDocument();
    expect(screen.getByText("Disable 2FA")).toBeInTheDocument();
  });

  it("shows setup flow when Set Up 2FA is clicked", async () => {
    setupMocks(false);

    mockPost.mockResolvedValueOnce({
      secret: "JBSWY3DPEHPK3PXP",
      otpauthUri: "otpauth://totp/Dominus%20Node:test@example.com?secret=JBSWY3DPEHPK3PXP",
      backupCodes: ["12345678", "23456789", "34567890", "45678901"],
    });

    renderWithProviders(<SecurityPage />);

    await waitFor(() => {
      expect(screen.getByText("Set Up 2FA")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Set Up 2FA"));

    await waitFor(() => {
      expect(screen.getByText("Scan QR Code")).toBeInTheDocument();
    });

    // The secret appears in both the otpauth URI and the manual-entry field
    expect(screen.getAllByText(/JBSWY3DPEHPK3PXP/).length).toBeGreaterThan(0);
    expect(screen.getByText("Backup Codes")).toBeInTheDocument();
    expect(screen.getByText("12345678")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable 2FA" })).toBeInTheDocument();
  });

  it("shows disable form when Disable 2FA is clicked", async () => {
    setupMocks(true, 10);
    renderWithProviders(<SecurityPage />);

    await waitFor(() => {
      expect(screen.getByText("Disable 2FA")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Disable 2FA"));

    await waitFor(() => {
      expect(screen.getByText(/Disabling 2FA will remove/)).toBeInTheDocument();
    });

    // Both the MFA disable form and the Password section have "Password" text,
    // so use getAllByText to verify it appears
    expect(screen.getAllByText("Password").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("TOTP or backup code")).toBeInTheDocument();
  });
});
