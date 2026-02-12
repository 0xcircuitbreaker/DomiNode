import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthProvider, useAuth } from "./AuthContext";

// Mock api/client
vi.mock("../api/client", () => ({
  get: vi.fn(),
  post: vi.fn(),
}));

import { get, post } from "../api/client";
const mockGet = vi.mocked(get);
const mockPost = vi.mocked(post);

// Helper component to expose auth state
function AuthConsumer() {
  const { user, loading, mfaRequired, isAdmin, login, logout, register } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="user">{user ? user.email : "null"}</span>
      <span data-testid="admin">{String(isAdmin)}</span>
      <span data-testid="mfa">{String(mfaRequired)}</span>
      <button onClick={() => login("test@test.com", "password123")}>Login</button>
      <button onClick={() => register("new@test.com", "password123")}>Register</button>
      <button onClick={() => logout()}>Logout</button>
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AuthContext", () => {
  it("starts in loading state and resolves to no user on failed /me", async () => {
    mockGet.mockRejectedValueOnce(new Error("Unauthorized"));

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    // Initially loading
    expect(screen.getByTestId("loading").textContent).toBe("true");

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    expect(screen.getByTestId("user").textContent).toBe("null");
  });

  it("sets user from /api/auth/me on mount", async () => {
    mockGet.mockResolvedValueOnce({
      user: { id: "1", email: "test@example.com", is_admin: false },
    });

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("test@example.com");
    });

    expect(screen.getByTestId("admin").textContent).toBe("false");
  });

  it("login sets user on success (no MFA)", async () => {
    // Initial /me call fails
    mockGet.mockRejectedValueOnce(new Error("Unauthorized"));

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    // Mock login response
    mockPost.mockResolvedValueOnce({
      user: { id: "2", email: "test@test.com", is_admin: true },
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Login"));

    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("test@test.com");
    });
    expect(screen.getByTestId("admin").textContent).toBe("true");
  });

  it("login sets mfaRequired when server returns mfaRequired", async () => {
    mockGet.mockRejectedValueOnce(new Error("Unauthorized"));

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    mockPost.mockResolvedValueOnce({ mfaRequired: true });

    const user = userEvent.setup();
    await user.click(screen.getByText("Login"));

    await waitFor(() => {
      expect(screen.getByTestId("mfa").textContent).toBe("true");
    });
  });

  it("logout clears user", async () => {
    mockGet.mockResolvedValueOnce({
      user: { id: "1", email: "test@example.com", is_admin: false },
    });

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("test@example.com");
    });

    mockPost.mockResolvedValueOnce(undefined);

    const user = userEvent.setup();
    await user.click(screen.getByText("Logout"));

    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("null");
    });
  });

  it("register sets user on success", async () => {
    mockGet.mockRejectedValueOnce(new Error("Unauthorized"));

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    mockPost.mockResolvedValueOnce({
      user: { id: "3", email: "new@test.com", is_admin: false },
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Register"));

    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("new@test.com");
    });
  });
});
