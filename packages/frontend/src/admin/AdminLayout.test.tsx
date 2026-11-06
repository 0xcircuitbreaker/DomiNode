import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import { ThemeProvider } from "../context/ThemeContext";
import AdminLayout, { isAdminUser } from "./AdminLayout";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));
import { ApiError, get, post } from "../api/client";
const mockGet = vi.mocked(get);
const mockPost = vi.mocked(post);

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/admin/nodes"]}>
      <ThemeProvider>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<div>LOGIN PAGE</div>} />
            <Route path="/admin" element={<AdminLayout />}>
              <Route path="nodes" element={<div>NODES CONTENT</div>} />
            </Route>
          </Routes>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

const admin = { id: "u1", email: "ops@example.com", is_admin: true, admin_role: "admin" };

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

describe("AdminLayout", () => {
  it("redirects to login when there is no session", async () => {
    mockGet.mockRejectedValue(new ApiError("Unauthorized", 401));
    renderShell();
    expect(await screen.findByText("LOGIN PAGE")).toBeInTheDocument();
  });

  it("shows access denied for non-admin users and hides the console", async () => {
    mockGet.mockResolvedValue({ user: { ...admin, is_admin: false, admin_role: "none" } });
    renderShell();
    expect(await screen.findByRole("heading", { name: "Access denied" })).toBeInTheDocument();
    expect(screen.queryByText("NODES CONTENT")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Admin" })).not.toBeInTheDocument();
  });

  it("renders nav and page for admins, and signs out", async () => {
    mockGet.mockResolvedValue({ user: admin });
    mockPost.mockResolvedValue(undefined);
    renderShell();
    expect(await screen.findByText("NODES CONTENT")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Admin" });
    for (const label of ["Overview", "Revenue", "Network", "Nodes", "Agents", "Credits & Payouts", "Disputes", "Abuse log", "Policy", "Pricing, Split & Tiers", "Health", "Audit"]) {
      expect(nav).toHaveTextContent(label);
    }
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(mockPost).toHaveBeenCalledWith("/api/auth/logout", {});
    await waitFor(() => expect(screen.getByText("LOGIN PAGE")).toBeInTheDocument());
  });

  it("opens the mobile menu", async () => {
    mockGet.mockResolvedValue({ user: admin });
    renderShell();
    await screen.findByText("NODES CONTENT");
    await userEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(screen.getAllByRole("navigation", { name: "Admin" })).toHaveLength(2);
  });

  it("isAdminUser requires a non-none admin_role", () => {
    expect(isAdminUser(null)).toBe(false);
    expect(isAdminUser({ admin_role: "none" })).toBe(false);
    expect(isAdminUser({ admin_role: "root_admin" })).toBe(true);
  });
});
