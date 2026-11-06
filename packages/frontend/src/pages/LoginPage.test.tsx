import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import LoginPage, { safeRedirectPath } from "./LoginPage";
import { AuthProvider } from "../context/AuthContext";
import { ThemeProvider } from "../context/ThemeContext";

vi.mock("../api/client", () => ({ get: vi.fn(), post: vi.fn() }));
import { get, post } from "../api/client";
const mockGet = vi.mocked(get);
const mockPost = vi.mocked(post);

function renderLogin(path = "/login") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/admin/*" element={<div>ADMIN HOME</div>} />
          </Routes>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

const user = { id: "u1", email: "ops@example.com", is_admin: true, admin_role: "admin" };

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockGet.mockRejectedValue(new Error("Unauthorized"));
});

describe("LoginPage", () => {
  it("renders the operator sign-in form without registration or wallet login", async () => {
    renderLogin();
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByText(/register/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/wallet/i)).not.toBeInTheDocument();
  });

  it("signs in and navigates to the redirect target", async () => {
    mockPost.mockResolvedValue({ user });
    renderLogin("/login?redirect=%2Fadmin%2Fnodes");
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText("Email"), "ops@example.com");
    await u.type(screen.getByLabelText("Password"), "password123");
    await u.click(screen.getByRole("button", { name: "Sign in" }));
    expect(mockPost).toHaveBeenCalledWith("/api/auth/login", { email: "ops@example.com", password: "password123" });
    expect(await screen.findByText("ADMIN HOME")).toBeInTheDocument();
  });

  it("walks through MFA", async () => {
    mockPost.mockResolvedValueOnce({ mfaRequired: true }).mockResolvedValueOnce({ user });
    renderLogin();
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText("Email"), "ops@example.com");
    await u.type(screen.getByLabelText("Password"), "password123");
    await u.click(screen.getByRole("button", { name: "Sign in" }));
    const code = await screen.findByLabelText("Authentication code");
    await u.type(code, "123456");
    await u.click(screen.getByRole("button", { name: "Verify" }));
    expect(mockPost).toHaveBeenLastCalledWith("/api/auth/mfa/verify", { code: "123456", isBackupCode: false });
    expect(await screen.findByText("ADMIN HOME")).toBeInTheDocument();
  });

  it("shows server errors", async () => {
    mockPost.mockRejectedValue(new Error("Invalid email or password"));
    renderLogin();
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText("Email"), "ops@example.com");
    await u.type(screen.getByLabelText("Password"), "wrongpass1");
    await u.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Invalid email or password"));
  });

  it("rejects open redirects", () => {
    expect(safeRedirectPath("//evil.com")).toBe("/admin");
    expect(safeRedirectPath("\\/evil.com")).toBe("/admin");
    expect(safeRedirectPath("https://evil.com")).toBe("/admin");
    expect(safeRedirectPath("/admin/nodes")).toBe("/admin/nodes");
    expect(safeRedirectPath(null)).toBe("/admin");
  });
});
