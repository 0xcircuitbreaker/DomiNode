import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { m, renderPage, UUID1, UUID2 } from "../test-helpers";

vi.mock("../../api/admin", async (orig) => {
  const actual = await orig<typeof import("../../api/admin")>();
  return {
    ...actual,
    adminApi: {
      nodes: vi.fn(), node: vi.fn(), nodeAction: vi.fn(), agents: vi.fn(), agent: vi.fn(), freeze: vi.fn(), unfreeze: vi.fn(),
      creditAccounts: vi.fn(), payouts: vi.fn(), reversePayout: vi.fn(), disputes: vi.fn(), resolveDispute: vi.fn(),
      abuseLog: vi.fn(), audit: vi.fn(),
    },
  };
});
import { adminApi, type NodeBase } from "../../api/admin";
import NodesPage from "./NodesPage";
import AgentsPage from "./AgentsPage";
import CreditsPage from "./CreditsPage";
import DisputesPage from "./DisputesPage";
import AbuseLogPage, { validateAbuseQuery } from "./AbuseLogPage";
import AuditPage from "./AuditPage";

const api = vi.mocked(adminApi);

const node: NodeBase = {
  id: UUID1, ownerUserId: UUID2, ownerWallet: "0xabc", nodePubkey: null, status: "active", attestationVersion: 1,
  observedIp: "203.0.113.5", ipPrefix: "203.0.113.0/24", asn: 64500, country: "US", ipClass: "residential", maxStreams: 32,
  maxGbDay: 5, reputation: 8500, byteDisputes: 0, agentVersion: "1.2.0", lastSeenAt: "2026-11-06T00:00:00Z", createdAt: "2026-10-01T00:00:00Z", online: true,
};
const nodeRow = { ...node, ownerEmail: "owner@x.io", bytesToday: "0", gbToday: "0.100000", bytes30d: "0", gb30d: "3.000000", openDisputes: 1 };
const paged = <T,>(items: T[]) => ({ limit: 50, offset: 0, total: items.length, items });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("NodesPage", () => {
  beforeEach(() => {
    api.nodes.mockResolvedValue(paged([nodeRow]));
    api.node.mockResolvedValue({
      node: { ...node, ownerEmail: "owner@x.io", ownerStatus: "active", ownerTier: "bronze" },
      dailyStats: [], reputationByTarget: [], disputes: [], chargesDaily: [], chargesByRail30d: [], adminActions: [],
    });
  });

  it("filters by status and sorts", async () => {
    renderPage(<NodesPage />, "/admin/nodes?status=quarantined");
    expect(await screen.findByText("owner@x.io")).toBeInTheDocument();
    expect(api.nodes).toHaveBeenLastCalledWith(expect.objectContaining({ status: "quarantined", sort: "created", order: "desc", offset: 0 }));
    await userEvent.selectOptions(screen.getByLabelText("Status"), "active");
    await waitFor(() => expect(api.nodes).toHaveBeenLastCalledWith(expect.objectContaining({ status: "active" })));
    await userEvent.click(screen.getByRole("button", { name: /Reputation/ }));
    await waitFor(() => expect(api.nodes).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "reputation", order: "desc" })));
  });

  it("quarantines a node from the drawer only after a reason is confirmed", async () => {
    api.nodeAction.mockResolvedValue({ nodeId: UUID1, previousStatus: "active", status: "quarantined", changed: true, gatewayEffect: "within_sync_interval" });
    renderPage(<NodesPage />);
    await userEvent.click(await screen.findByText("owner@x.io"));
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("203.0.113.0/24")).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "Activate" })).toBeDisabled();
    await userEvent.click(within(drawer).getByRole("button", { name: "Quarantine" }));
    const dlg = screen.getByRole("alertdialog");
    const confirm = within(dlg).getByRole("button", { name: "Quarantine" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dlg).getByLabelText(/Reason/), "abuse report #12");
    await userEvent.click(confirm);
    expect(api.nodeAction).toHaveBeenCalledWith(UUID1, "quarantine", "abuse report #12");
    expect(await screen.findByText(/active → quarantined/)).toBeInTheDocument();
  });

  it("cancel closes the confirm dialog without calling the API", async () => {
    renderPage(<NodesPage />);
    await userEvent.click(await screen.findByText("owner@x.io"));
    const drawer = await screen.findByRole("dialog");
    await within(drawer).findByText("203.0.113.0/24");
    await userEvent.click(within(drawer).getByRole("button", { name: "Revoke" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.nodeAction).not.toHaveBeenCalled();
  });
});

const agent = {
  userId: UUID2, email: "agent@x.io", walletAddress: null, status: "active" as const, createdAt: "2026-10-01T00:00:00Z",
  tier: "bronze", tierId: 1, isRequester: true, isNodeOwner: true, spend: m(10), spend30d: m(5), bytesRequested: "0", gbRequested: "2.000000",
  lastRequestAt: null, earnings: m(3), earnings30d: m(1), nodes: 2, activeNodes: 1, onlineNodes: 1,
  credits: { pending: m(1), available: m(2), frozen: true }, walletBalance: m(7),
};

describe("AgentsPage", () => {
  it("filters, opens detail and unfreezes with reverse mode", async () => {
    api.agents.mockResolvedValue(paged([agent]));
    api.agent.mockResolvedValue({ agent, creditAccount: null, nodes: [node], recentPayouts: [], recentCreditTransactions: [], spendByRail30d: [] });
    api.unfreeze.mockResolvedValue({ userId: UUID2, mode: "reverse", wasFrozen: true, payouts: 2, musd: "5000000" });
    renderPage(<AgentsPage />);
    await userEvent.click(await screen.findByText("agent@x.io"));
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(await within(drawer).findByRole("button", { name: "Unfreeze" }));
    const dlg = screen.getByRole("alertdialog");
    await userEvent.click(within(dlg).getByRole("radio", { name: /Reverse/ }));
    await userEvent.click(within(dlg).getByRole("button", { name: "Unfreeze" }));
    expect(api.unfreeze).toHaveBeenCalledWith(UUID2, "reverse");
    expect(await screen.findByText(/2 held payout\(s\) reversed/)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Credits"), "true");
    await waitFor(() => expect(api.agents).toHaveBeenLastCalledWith(expect.objectContaining({ frozen: "true", offset: 0 })));
  });
});

describe("CreditsPage", () => {
  it("filters frozen accounts and reverses a payout", async () => {
    api.creditAccounts.mockResolvedValue(paged([{ userId: UUID2, email: "acct@x.io", walletAddress: null, pending: m(1), available: m(2), frozen: false, autoConvertPct: 0, taxFormStatus: "not_required", ytdPaid: m(0), heldPayouts: m(0), updatedAt: "2026-11-01T00:00:00Z" }]));
    api.payouts.mockResolvedValue({ ...paged([{ id: UUID1, userId: UUID2, email: "acct@x.io", amount: m(25), trigger: "auto" as const, status: "failed" as const, batchId: null, txHash: null, failureReason: "rpc", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", payoutWallet: null }]), totalAmount: m(25) });
    api.reversePayout.mockResolvedValue({ id: UUID1, status: "reversed", amount: m(25) });
    renderPage(<CreditsPage />);
    expect(await screen.findAllByText("acct@x.io")).toHaveLength(2);
    await userEvent.selectOptions(screen.getByLabelText("Frozen"), "true");
    await waitFor(() => expect(api.creditAccounts).toHaveBeenLastCalledWith(expect.objectContaining({ frozen: "true" })));
    await userEvent.selectOptions(screen.getByLabelText("Status"), "failed");
    await waitFor(() => expect(api.payouts).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed" })));

    await userEvent.click(screen.getByRole("button", { name: "Reverse" }));
    const dlg = screen.getByRole("alertdialog");
    await userEvent.type(within(dlg).getByLabelText(/Reason/), "duplicate");
    await userEvent.click(within(dlg).getByRole("button", { name: "Reverse payout" }));
    expect(api.reversePayout).toHaveBeenCalledWith(UUID1, "duplicate");
  });

  it("surfaces API errors inside the dialog", async () => {
    api.creditAccounts.mockResolvedValue(paged([]));
    api.payouts.mockResolvedValue({ ...paged([{ id: UUID1, userId: UUID2, email: null, amount: m(25), trigger: "auto" as const, status: "pending" as const, batchId: null, txHash: null, failureReason: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", payoutWallet: null }]), totalAmount: m(25) });
    api.reversePayout.mockRejectedValue(new Error("Payout already submitted"));
    renderPage(<CreditsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Reverse" }));
    const dlg = screen.getByRole("alertdialog");
    await userEvent.type(within(dlg).getByLabelText(/Reason/), "x");
    await userEvent.click(within(dlg).getByRole("button", { name: "Reverse payout" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("Payout already submitted");
  });
});

describe("DisputesPage", () => {
  it("resolves an open dispute in favour of the node", async () => {
    api.disputes.mockResolvedValue(paged([{ id: "42", relayChargeId: "c1", nodeId: UUID1, nodeOwnerUserId: UUID2, requesterUserId: UUID2, paymentRail: "wallet" as const, bytesGateway: "1000", bytesNode: "1500", bytesDiff: "500", diffBps: 5000, gross: m(0.001), nodeShare: m(0.0003), status: "open" as const, createdAt: "2026-11-01T00:00:00Z", resolvedAt: null }]));
    api.resolveDispute.mockResolvedValue({ id: "42", status: "resolved_node", chargeReleased: false });
    renderPage(<DisputesPage />);
    expect(api.disputes).toHaveBeenCalledWith({ status: "open", limit: 50, offset: 0 });
    await userEvent.click(await screen.findByRole("button", { name: "Resolve" }));
    const dlg = screen.getByRole("alertdialog");
    await userEvent.click(within(dlg).getByRole("radio", { name: /Node count is right/ }));
    await userEvent.click(within(dlg).getByRole("button", { name: "Resolve" }));
    expect(api.resolveDispute).toHaveBeenCalledWith("42", "resolved_node", undefined);
    expect(await screen.findByText(/Dispute 42 resolved node/)).toBeInTheDocument();
  });
});

describe("AbuseLogPage", () => {
  it("validates the window and does not query until submitted", async () => {
    api.abuseLog.mockResolvedValue({ from: "2026-11-05T00:00:00Z", to: "2026-11-06T00:00:00Z", retentionDays: 90, limit: 100, offset: 0, total: 1,
      items: [{ id: "1", ts: "2026-11-05T10:00:00Z", sessionId: "s1", requesterUserId: UUID2, nodeId: UUID1, destHost: "example.com", destPort: 443, bytes: "2048" }] });
    renderPage(<AbuseLogPage />);
    expect(api.abuseLog).not.toHaveBeenCalled();
    const from = screen.getByLabelText("From (UTC)");
    await userEvent.clear(from);
    await userEvent.type(from, "2026-09-01T00:00");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("31 days or less");
    expect(api.abuseLog).not.toHaveBeenCalled();

    await userEvent.clear(from);
    await userEvent.type(from, "2026-11-01T00:00");
    await userEvent.type(screen.getByLabelText("Destination host"), "example.com");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("example.com:443")).toBeInTheDocument();
    expect(api.abuseLog).toHaveBeenCalledWith(expect.objectContaining({ host: "example.com", from: "2026-11-01T00:00:00.000Z" }));
  });

  it("rejects malformed ids", () => {
    const base = { nodeId: "", requesterId: "", host: "", from: "2026-11-01T00:00", to: "2026-11-02T00:00" };
    expect(validateAbuseQuery(base)).toBeNull();
    expect(validateAbuseQuery({ ...base, nodeId: "nope" })).toMatch(/UUID/);
    expect(validateAbuseQuery({ ...base, host: "a b" })).toMatch(/hostname/);
    expect(validateAbuseQuery({ ...base, from: "2026-11-03T00:00" })).toMatch(/before/);
  });
});

describe("AuditPage", () => {
  it("filters by action", async () => {
    api.audit.mockResolvedValue(paged([{ id: "a1", adminUserId: UUID2, adminEmail: "ops@x.io", action: "network_policy_publish", resource: "network_policy", resourceId: "3", ipAddress: "127.0.0.1", details: { version: 3 }, createdAt: "2026-11-01T00:00:00Z" }]));
    renderPage(<AuditPage />);
    expect(await screen.findByText("ops@x.io")).toBeInTheDocument();
    expect(screen.getAllByText("version: 3").length).toBeGreaterThan(0);
    await userEvent.selectOptions(screen.getByLabelText("Action"), "node_revoke");
    await waitFor(() => expect(api.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "node_revoke", offset: 0 })));
  });
});
