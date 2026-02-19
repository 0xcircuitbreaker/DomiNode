import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import TeamsPage from "./TeamsPage";

// Mock api/client
vi.mock("../api/client", () => ({
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
}));

import { get, post, del } from "../api/client";
const mockGet = vi.mocked(get);
const mockPost = vi.mocked(post);
const mockDel = vi.mocked(del);

const TEAM_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const TEAM_ID_2 = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
const MEMBER_ID = "c3d4e5f6-a7b8-9012-cdef-123456789012";
const INVITE_ID = "d4e5f6a7-b8c9-0123-def0-234567890123";
const KEY_ID = "e5f6a7b8-c9d0-1234-ef01-345678901234";

beforeEach(() => {
  vi.clearAllMocks();
});

interface SetupOptions {
  teams?: Array<{
    id: string;
    name: string;
    role: string;
    balance_cents: number;
    created_at: string;
  }>;
  members?: Array<{
    id: string;
    user_id: string;
    email: string;
    role: string;
    joined_at: string;
  }>;
  invites?: Array<{
    id: string;
    email: string;
    role: string;
    created_at: string;
    expires_at: string;
  }>;
  keys?: Array<{
    id: string;
    prefix: string;
    label: string;
    created_at: string;
  }>;
  transactions?: Array<{
    id: string;
    type: string;
    amount_cents: number;
    description: string;
    created_at: string;
  }>;
  teamDetail?: {
    id: string;
    name: string;
    role: string;
    balance_cents: number;
    created_at: string;
  };
}

function setupMocks(opts: SetupOptions = {}) {
  const {
    teams = [],
    members = [],
    invites = [],
    keys = [],
    transactions = [],
    teamDetail,
  } = opts;

  mockGet.mockImplementation((path: string) => {
    if (path === "/api/auth/me") {
      return Promise.resolve({
        user: { id: "1", email: "test@example.com", is_admin: false },
      });
    }
    if (path === "/api/teams") {
      return Promise.resolve(teams);
    }
    if (path.match(/^\/api\/teams\/[^/]+$/)) {
      return Promise.resolve(
        teamDetail ?? teams.find((t) => path.includes(t.id)) ?? {
          id: TEAM_ID,
          name: "Test Team",
          role: "owner",
          balance_cents: 5000,
          created_at: "2025-01-01T00:00:00Z",
        },
      );
    }
    if (path.match(/^\/api\/teams\/[^/]+\/members$/)) {
      return Promise.resolve({ members });
    }
    if (path.match(/^\/api\/teams\/[^/]+\/invites$/)) {
      return Promise.resolve({ invites });
    }
    if (path.match(/^\/api\/teams\/[^/]+\/keys$/)) {
      return Promise.resolve({ keys });
    }
    if (path.match(/^\/api\/teams\/[^/]+\/wallet\/transactions$/)) {
      return Promise.resolve({ transactions });
    }
    return Promise.reject(new Error(`Unexpected get: ${path}`));
  });
}

const defaultTeam = {
  id: TEAM_ID,
  name: "Alpha Team",
  role: "owner",
  balance_cents: 5000,
  created_at: "2025-01-01T00:00:00Z",
};

const secondTeam = {
  id: TEAM_ID_2,
  name: "Beta Team",
  role: "member",
  balance_cents: 1200,
  created_at: "2025-02-01T00:00:00Z",
};

describe("TeamsPage", () => {
  it("renders the page with create team form", async () => {
    setupMocks();
    renderWithProviders(<TeamsPage />);

    await waitFor(() => {
      expect(screen.getByText("Teams")).toBeInTheDocument();
    });

    // "Create Team" appears as both heading and button
    expect(screen.getAllByText("Create Team").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByPlaceholderText("Team name")).toBeInTheDocument();
    expect(screen.getByText("My Teams")).toBeInTheDocument();
  });

  it("shows 'No teams' when API returns empty list", async () => {
    setupMocks({ teams: [] });
    renderWithProviders(<TeamsPage />);

    await waitFor(() => {
      expect(
        screen.getByText("No teams yet. Create one to get started."),
      ).toBeInTheDocument();
    });
  });

  it("loads and displays teams list", async () => {
    setupMocks({ teams: [defaultTeam, secondTeam] });
    renderWithProviders(<TeamsPage />);

    await waitFor(() => {
      expect(screen.getByText("Alpha Team")).toBeInTheDocument();
    });

    expect(screen.getByText("Beta Team")).toBeInTheDocument();
    expect(screen.getByText("$50.00")).toBeInTheDocument();
    expect(screen.getByText("$12.00")).toBeInTheDocument();
  });

  it("creates a new team successfully", async () => {
    // Start with no teams, then return the new team after creation
    let teamsData: typeof defaultTeam[] = [];
    mockGet.mockImplementation((path: string) => {
      if (path === "/api/auth/me") {
        return Promise.resolve({
          user: { id: "1", email: "test@example.com", is_admin: false },
        });
      }
      if (path === "/api/teams") {
        return Promise.resolve(teamsData);
      }
      return Promise.reject(new Error(`Unexpected get: ${path}`));
    });

    mockPost.mockResolvedValueOnce({ id: TEAM_ID, name: "New Team" });

    renderWithProviders(<TeamsPage />);

    await waitFor(() => {
      expect(
        screen.getByText("No teams yet. Create one to get started."),
      ).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Team name"), "New Team");

    // After creation, API returns the new team
    teamsData = [
      {
        id: TEAM_ID,
        name: "New Team",
        role: "owner",
        balance_cents: 0,
        created_at: "2025-03-01T00:00:00Z",
      },
    ];

    await user.click(screen.getByRole("button", { name: "Create Team" }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith("/api/teams", { name: "New Team" });
    });

    await waitFor(() => {
      expect(screen.getByText("Team created successfully.")).toBeInTheDocument();
    });
  });

  it("shows error when team creation fails", async () => {
    setupMocks({ teams: [] });
    mockPost.mockRejectedValueOnce(new Error("Team limit reached"));

    renderWithProviders(<TeamsPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Team name")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Team name"), "Bad Team");
    await user.click(screen.getByRole("button", { name: "Create Team" }));

    await waitFor(() => {
      expect(screen.getByText("Team limit reached")).toBeInTheDocument();
    });
  });

  it("selects a team and shows detail view with tabs", async () => {
    setupMocks({
      teams: [defaultTeam],
      members: [],
    });
    renderWithProviders(<TeamsPage />);

    await waitFor(() => {
      expect(screen.getByText("Alpha Team")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Alpha Team"));

    await waitFor(() => {
      // The detail header shows the team name and role badge
      const teamNames = screen.getAllByText("Alpha Team");
      expect(teamNames.length).toBeGreaterThanOrEqual(2); // list + detail header
    });

    // Check all four sub-tabs exist
    expect(screen.getByText("Members")).toBeInTheDocument();
    expect(screen.getByText("Invites")).toBeInTheDocument();
    expect(screen.getByText("API Keys")).toBeInTheDocument();
    expect(screen.getByText("Wallet")).toBeInTheDocument();

    // Owner should see the Delete Team button
    expect(screen.getByText("Delete Team")).toBeInTheDocument();
  });

  it("shows members list when Members tab is active", async () => {
    setupMocks({
      teams: [defaultTeam],
      members: [
        {
          id: "m1",
          user_id: MEMBER_ID,
          email: "alice@example.com",
          role: "owner",
          joined_at: "2025-01-01T00:00:00Z",
        },
        {
          id: "m2",
          user_id: "f1234567-abcd-1234-abcd-123456789abc",
          email: "bob@example.com",
          role: "member",
          joined_at: "2025-01-05T00:00:00Z",
        },
      ],
    });
    renderWithProviders(<TeamsPage />);

    await waitFor(() => {
      expect(screen.getByText("Alpha Team")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Alpha Team"));

    // Members tab is the default active tab
    await waitFor(() => {
      expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    });

    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Add member by email")).toBeInTheDocument();
    expect(screen.getByText("Add Member")).toBeInTheDocument();

    // Non-owner member has a Remove button; owner does not
    const removeButtons = screen.getAllByText("Remove");
    expect(removeButtons.length).toBe(1); // only bob (member role) has Remove
  });

  it("shows invites section when Invites tab is active", async () => {
    setupMocks({
      teams: [defaultTeam],
      members: [],
      invites: [
        {
          id: INVITE_ID,
          email: "carol@example.com",
          role: "member",
          created_at: "2025-01-10T00:00:00Z",
          expires_at: "2025-01-17T00:00:00Z",
        },
      ],
    });
    renderWithProviders(<TeamsPage />);

    await waitFor(() => {
      expect(screen.getByText("Alpha Team")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Alpha Team"));

    // Wait for members tab to load, then switch to invites
    await waitFor(() => {
      expect(screen.getByText("Invites")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Invites"));

    await waitFor(() => {
      expect(screen.getByText("carol@example.com")).toBeInTheDocument();
    });

    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Email address")).toBeInTheDocument();
    expect(screen.getByText("Send Invite")).toBeInTheDocument();
  });

  it("shows API keys section when Keys tab is active", async () => {
    setupMocks({
      teams: [defaultTeam],
      members: [],
      keys: [
        {
          id: KEY_ID,
          prefix: "dn_live_abc",
          label: "Production",
          created_at: "2025-01-10T00:00:00Z",
        },
      ],
    });
    renderWithProviders(<TeamsPage />);

    await waitFor(() => {
      expect(screen.getByText("Alpha Team")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Alpha Team"));

    await waitFor(() => {
      expect(screen.getByText("API Keys")).toBeInTheDocument();
    });

    await user.click(screen.getByText("API Keys"));

    await waitFor(() => {
      expect(screen.getByText("dn_live_abc...")).toBeInTheDocument();
    });

    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByText("Revoke")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Key label (e.g. Production)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Create Key")).toBeInTheDocument();
  });

  it("shows wallet section with balance and fund form", async () => {
    setupMocks({
      teams: [defaultTeam],
      members: [],
      teamDetail: {
        id: TEAM_ID,
        name: "Alpha Team",
        role: "owner",
        balance_cents: 5000,
        created_at: "2025-01-01T00:00:00Z",
      },
      transactions: [
        {
          id: "tx1",
          type: "fund",
          amount_cents: 5000,
          description: "Initial funding",
          created_at: "2025-01-15T00:00:00Z",
        },
      ],
    });
    renderWithProviders(<TeamsPage />);

    await waitFor(() => {
      expect(screen.getByText("Alpha Team")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Alpha Team"));

    await waitFor(() => {
      expect(screen.getByText("Wallet")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Wallet"));

    await waitFor(() => {
      expect(screen.getByText("Team Balance")).toBeInTheDocument();
    });

    // $50.00 appears in both the teams list and the wallet balance
    expect(screen.getAllByText("$50.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Fund Team Wallet")).toBeInTheDocument();
    expect(screen.getByText("Fund")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("0.00")).toBeInTheDocument();

    // Transaction history
    await waitFor(() => {
      expect(screen.getByText("Transaction History")).toBeInTheDocument();
    });
    expect(screen.getByText("Initial funding")).toBeInTheDocument();
  });

  it("deletes a team with confirmation", async () => {
    // Mock window.confirm to return true
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    let teamsData = [defaultTeam];
    mockGet.mockImplementation((path: string) => {
      if (path === "/api/auth/me") {
        return Promise.resolve({
          user: { id: "1", email: "test@example.com", is_admin: false },
        });
      }
      if (path === "/api/teams") {
        return Promise.resolve(teamsData);
      }
      if (path.match(/^\/api\/teams\/[^/]+$/)) {
        return Promise.resolve(defaultTeam);
      }
      if (path.match(/^\/api\/teams\/[^/]+\/members$/)) {
        return Promise.resolve({ members: [] });
      }
      return Promise.reject(new Error(`Unexpected get: ${path}`));
    });

    mockDel.mockResolvedValueOnce(undefined as never);

    renderWithProviders(<TeamsPage />);

    await waitFor(() => {
      expect(screen.getByText("Alpha Team")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Alpha Team"));

    await waitFor(() => {
      expect(screen.getByText("Delete Team")).toBeInTheDocument();
    });

    // After deletion, API returns empty list
    teamsData = [];

    await user.click(screen.getByText("Delete Team"));

    await waitFor(() => {
      expect(mockDel).toHaveBeenCalledWith(`/api/teams/${TEAM_ID}`);
    });

    await waitFor(() => {
      expect(screen.getByText("Team deleted.")).toBeInTheDocument();
    });

    confirmSpy.mockRestore();
  });

  it("shows loading state while fetching teams", async () => {
    // Set up a delayed response
    mockGet.mockImplementation((path: string) => {
      if (path === "/api/auth/me") {
        return Promise.resolve({
          user: { id: "1", email: "test@example.com", is_admin: false },
        });
      }
      if (path === "/api/teams") {
        return new Promise(() => {}); // Never resolves - stays loading
      }
      return Promise.reject(new Error(`Unexpected get: ${path}`));
    });

    renderWithProviders(<TeamsPage />);

    await waitFor(() => {
      expect(screen.getByText("Loading...")).toBeInTheDocument();
    });
  });

  it("shows error when teams fetch fails", async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === "/api/auth/me") {
        return Promise.resolve({
          user: { id: "1", email: "test@example.com", is_admin: false },
        });
      }
      if (path === "/api/teams") {
        return Promise.reject(new Error("Network error"));
      }
      return Promise.reject(new Error(`Unexpected get: ${path}`));
    });

    renderWithProviders(<TeamsPage />);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  it("does not show Delete Team button for non-owner members", async () => {
    const memberTeam = {
      id: TEAM_ID,
      name: "Other Team",
      role: "member",
      balance_cents: 3000,
      created_at: "2025-01-01T00:00:00Z",
    };

    setupMocks({
      teams: [memberTeam],
      members: [],
    });
    renderWithProviders(<TeamsPage />);

    await waitFor(() => {
      expect(screen.getByText("Other Team")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Other Team"));

    await waitFor(() => {
      // Detail view is visible with tabs
      expect(screen.getByText("Members")).toBeInTheDocument();
    });

    // Delete Team button should NOT be present for non-owner
    expect(screen.queryByText("Delete Team")).not.toBeInTheDocument();
  });
});
