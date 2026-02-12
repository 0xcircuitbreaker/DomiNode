import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import LoginPage from "./LoginPage";
import { AuthProvider } from "../context/AuthContext";
import { ThemeProvider } from "../context/ThemeContext";
import { BRAND_NAME } from "../config/branding";

// Mock api/client
vi.mock("../api/client", () => ({
  get: vi.fn(),
  post: vi.fn(),
}));

import { get, post } from "../api/client";
const mockGet = vi.mocked(get);
const mockPost = vi.mocked(post);

function renderLoginPage() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <ThemeProvider>
        <AuthProvider>
          <LoginPage />
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // By default, /me call fails (user not logged in)
  mockGet.mockRejectedValue(new Error("Unauthorized"));
});

describe("LoginPage", () => {
  it("renders sign-in form with email and password fields", async () => {
    renderLoginPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Sign In" })).toBeInTheDocument();
    });

    expect(screen.getByPlaceholderText("you@example.com")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Min 8 characters")).toBeInTheDocument();
    expect(screen.getAllByText(BRAND_NAME).length).toBeGreaterThan(0);
    expect(screen.getByText("Residential Proxy Service")).toBeInTheDocument();
  });

  it("toggles between sign in and register mode", async () => {
    renderLoginPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Sign In" })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Register"));

    expect(screen.getByRole("heading", { name: "Create Account" })).toBeInTheDocument();
    expect(screen.getByText("Already have an account?")).toBeInTheDocument();
  });

  it("shows error on failed login", async () => {
    renderLoginPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Sign In" })).toBeInTheDocument();
    });

    mockPost.mockRejectedValueOnce(new Error("Invalid credentials"));

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("you@example.com"), "bad@test.com");
    await user.type(screen.getByPlaceholderText("Min 8 characters"), "wrongpass");
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(screen.getByText("Invalid credentials")).toBeInTheDocument();
    });
  });

  it("shows MFA form when login returns mfaRequired", async () => {
    renderLoginPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Sign In" })).toBeInTheDocument();
    });

    mockPost.mockResolvedValueOnce({ mfaRequired: true });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("you@example.com"), "test@test.com");
    await user.type(screen.getByPlaceholderText("Min 8 characters"), "password123");
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(screen.getByText("Two-Factor Authentication")).toBeInTheDocument();
    });

    expect(screen.getByRole("heading", { name: "Enter Authentication Code" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("000000")).toBeInTheDocument();
  });

  it("shows backup code option in MFA form", async () => {
    renderLoginPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Sign In" })).toBeInTheDocument();
    });

    mockPost.mockResolvedValueOnce({ mfaRequired: true });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("you@example.com"), "test@test.com");
    await user.type(screen.getByPlaceholderText("Min 8 characters"), "password123");
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(screen.getByText("Use backup code")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Use backup code"));

    expect(screen.getByRole("heading", { name: "Enter Backup Code" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("00000000")).toBeInTheDocument();
  });
});
