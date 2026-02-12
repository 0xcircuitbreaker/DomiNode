import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import ApiKeysPage from "./ApiKeysPage";

// Mock api/client
vi.mock("../api/client", () => ({
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
}));

import { get, post } from "../api/client";
const mockGet = vi.mocked(get);
const mockPost = vi.mocked(post);

beforeEach(() => {
  vi.clearAllMocks();
});

function setupMocks(keys: Array<{ id: string; prefix: string; label: string; created_at: string; revoked_at: string | null }> = []) {
  mockGet.mockImplementation((path: string) => {
    if (path === "/api/auth/me") {
      return Promise.resolve({
        user: { id: "1", email: "test@example.com", is_admin: false },
      });
    }
    if (path === "/api/keys") {
      return Promise.resolve({ keys });
    }
    return Promise.reject(new Error(`Unexpected get: ${path}`));
  });
}

describe("ApiKeysPage", () => {
  it("renders the API Keys heading and Create Key button", async () => {
    setupMocks();
    renderWithProviders(<ApiKeysPage />);

    await waitFor(() => {
      expect(screen.getByText("API Keys")).toBeInTheDocument();
    });

    expect(screen.getByText("Create Key")).toBeInTheDocument();
  });

  it("shows empty state when no keys exist", async () => {
    setupMocks([]);
    renderWithProviders(<ApiKeysPage />);

    await waitFor(() => {
      expect(screen.getByText("No active API keys. Create one to get started.")).toBeInTheDocument();
    });
  });

  it("renders active keys in a table", async () => {
    setupMocks([
      {
        id: "key-1",
        prefix: "dn_live_abc",
        label: "Production",
        created_at: "2025-01-01T00:00:00Z",
        revoked_at: null,
      },
      {
        id: "key-2",
        prefix: "dn_live_def",
        label: "Testing",
        created_at: "2025-01-02T00:00:00Z",
        revoked_at: null,
      },
    ]);

    renderWithProviders(<ApiKeysPage />);

    await waitFor(() => {
      expect(screen.getByText("dn_live_abc...")).toBeInTheDocument();
    });

    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByText("dn_live_def...")).toBeInTheDocument();
    expect(screen.getByText("Testing")).toBeInTheDocument();
  });

  it("shows revoked keys section when revoked keys exist", async () => {
    setupMocks([
      {
        id: "key-1",
        prefix: "dn_live_abc",
        label: "Old Key",
        created_at: "2025-01-01T00:00:00Z",
        revoked_at: "2025-01-15T00:00:00Z",
      },
    ]);

    renderWithProviders(<ApiKeysPage />);

    await waitFor(() => {
      expect(screen.getByText("Revoked Keys")).toBeInTheDocument();
    });

    expect(screen.getByText("Old Key")).toBeInTheDocument();
  });

  it("opens create key modal when Create Key button is clicked", async () => {
    setupMocks([]);
    renderWithProviders(<ApiKeysPage />);

    await waitFor(() => {
      expect(screen.getByText("Create Key")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Create Key"));

    await waitFor(() => {
      expect(screen.getByText("Create API Key")).toBeInTheDocument();
    });

    expect(screen.getByPlaceholderText("e.g. Production, Scraper, etc.")).toBeInTheDocument();
  });

  it("creates a key and shows the key value in modal", async () => {
    setupMocks([]);

    mockPost.mockResolvedValueOnce({
      key: "dn_live_full_key_here",
      id: "new-key-1",
      prefix: "dn_live_ful",
      label: "Default",
    });

    renderWithProviders(<ApiKeysPage />);

    await waitFor(() => {
      expect(screen.getByText("Create Key")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Create Key"));

    await waitFor(() => {
      expect(screen.getByText("Create API Key")).toBeInTheDocument();
    });

    // Click the inner "Create Key" button in the modal
    const createButtons = screen.getAllByRole("button");
    const modalCreateBtn = createButtons.find(
      (btn) => btn.textContent === "Create Key" && btn.closest(".fixed"),
    );

    if (modalCreateBtn) {
      await user.click(modalCreateBtn);
    }

    await waitFor(() => {
      expect(screen.getByText("Key Created")).toBeInTheDocument();
    });

    expect(screen.getByDisplayValue("dn_live_full_key_here")).toBeInTheDocument();
    expect(screen.getByText(/Copy this key now/)).toBeInTheDocument();
  });
});
