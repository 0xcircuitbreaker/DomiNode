import { Router } from "express";
import * as crypto from "node:crypto";
import {
  teamRepo,
  createLogger,
  generateApiKey,
  isValidEmail,
  sanitizeString,
  sendTeamInviteEmail,
  userRepo,
} from "@dominusnode/shared";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { refusedBySwitch } from "../helpers/kill-switch.js";
import { agentAwareRateLimit } from "../helpers/agent-rate-limit.js";

const router = Router();
const log = createLogger("api:teams");

// UUID v4 validation regex
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rate limiters (agents get boosted for swarm operations)
const financialLimiter = agentAwareRateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many financial operations. Please try again later." },
  keyGenerator: (req) => (req as unknown as AuthenticatedRequest).user?.userId ?? "unknown",
});

const inviteLimiter = agentAwareRateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many invite operations. Please try again later." },
  keyGenerator: (req) => (req as unknown as AuthenticatedRequest).user?.userId ?? "unknown",
});

// ─── Public Endpoints (no auth required) ─────────────────────────────

// GET /api/teams/invites/:token — Public invite details (no auth needed to view)
router.get("/invites/:token", async (req, res) => {
  try {
    const token = req.params.token as string;

    if (typeof token !== "string" || token.length !== 64 || !/^[0-9a-f]+$/i.test(token)) {
      res.status(400).json({ error: "Invalid invite token format" });
      return;
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const invite = await teamRepo.getInviteByToken(tokenHash);

    if (!invite) {
      res.status(404).json({ error: "Invite not found or expired" });
      return;
    }

    if (new Date(invite.expires_at) < new Date()) {
      res.status(410).json({ error: "Invite has expired" });
      return;
    }

    // Mask email in public response — token possession doesn't grant PII access
    const maskedEmail = invite.email.replace(/^(.{2}).*(@.*)$/, "$1***$2");
    res.json({
      id: invite.id,
      teamId: invite.team_id,
      teamName: invite.team_name,
      email: maskedEmail,
      role: invite.role,
      expiresAt: invite.expires_at,
      createdAt: invite.created_at,
    });
  } catch (err) {
    log.error("get invite details failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to get invite details" });
  }
});

// ─── Authenticated Endpoints ─────────────────────────────────────────
router.use(requireAuth);

// ─── Team CRUD ───────────────────────────────────────────────────────

// POST /api/teams — Create team
router.post("/", async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;

    // Require verified email before creating teams
    const teamCreator = await userRepo.findUserById(userId);
    if (!teamCreator || !teamCreator.email_verified) {
      res.status(403).json({ error: "Email verification required before creating teams", code: "EMAIL_NOT_VERIFIED" });
      return;
    }

    const name = sanitizeString(typeof req.body.name === "string" ? req.body.name : "", 100);
    const maxMembers = req.body.maxMembers !== undefined
      ? parseInt(req.body.maxMembers, 10)
      : undefined;

    if (!name || name.length > 100) {
      res.status(400).json({ error: "Team name must be 1-100 characters" });
      return;
    }

    if (maxMembers !== undefined) {
      if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 100) {
        res.status(400).json({ error: "maxMembers must be between 1 and 100" });
        return;
      }
    }

    const team = await teamRepo.createTeam(userId, name, "payg", maxMembers);

    log.info("team created", { userId, teamId: team.id });

    res.status(201).json({
      id: team.id,
      name: team.name,
      ownerId: team.owner_id,
      maxMembers: maxMembers ?? team.max_members,
      status: team.status,
      walletId: team.walletId,
      createdAt: team.created_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Maximum of")) {
      res.status(409).json({ error: msg });
      return;
    }
    log.error("create team failed", { error: msg });
    res.status(500).json({ error: "Failed to create team" });
  }
});

// GET /api/teams — List user's teams
router.get("/", async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const teams = await teamRepo.listTeams(userId);

    res.json({
      teams: teams.map((t) => ({
        id: t.id,
        name: t.name,
        ownerId: t.owner_id,
        maxMembers: t.max_members,
        status: t.status,
        role: t.role,
        balanceCents: t.balance_cents,
        createdAt: t.created_at,
      })),
    });
  } catch (err) {
    log.error("list teams failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to list teams" });
  }
});

// GET /api/teams/:id — Get team details
router.get("/:id", async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const teamId = req.params.id as string;

    if (!UUID_RE.test(teamId)) {
      res.status(400).json({ error: "Invalid team ID format" });
      return;
    }

    const team = await teamRepo.getTeam(teamId, userId);
    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }

    res.json({
      id: team.id,
      name: team.name,
      ownerId: team.owner_id,
      maxMembers: team.max_members,
      status: team.status,
      role: team.role,
      balanceCents: team.balance_cents,
      createdAt: team.created_at,
    });
  } catch (err) {
    log.error("get team failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to get team" });
  }
});

// PATCH /api/teams/:id — Update team (owner/admin only)
router.patch("/:id", async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const teamId = req.params.id as string;

    if (!UUID_RE.test(teamId)) {
      res.status(400).json({ error: "Invalid team ID format" });
      return;
    }

    const updates: { name?: string; maxMembers?: number } = {};

    if (req.body.name !== undefined) {
      const name = sanitizeString(typeof req.body.name === "string" ? req.body.name : "", 100);
      if (!name || name.length > 100) {
        res.status(400).json({ error: "Team name must be 1-100 characters" });
        return;
      }
      updates.name = name;
    }

    if (req.body.maxMembers !== undefined) {
      const maxMembers = parseInt(req.body.maxMembers, 10);
      if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 100) {
        res.status(400).json({ error: "maxMembers must be between 1 and 100" });
        return;
      }
      updates.maxMembers = maxMembers;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No updates provided" });
      return;
    }

    const team = await teamRepo.updateTeam(teamId, userId, updates);
    log.info("team updated", { userId, teamId });

    res.json({
      id: team.id,
      name: team.name,
      ownerId: team.owner_id,
      maxMembers: team.max_members,
      status: team.status,
      createdAt: team.created_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Only team owners") || msg.includes("Only the team owner")) {
      res.status(403).json({ error: msg });
      return;
    }
    if (msg.includes("not found") || msg.includes("No updates")) {
      res.status(404).json({ error: msg });
      return;
    }
    log.error("update team failed", { error: msg });
    res.status(500).json({ error: "Failed to update team" });
  }
});

// DELETE /api/teams/:id — Delete team + refund (owner only)
router.delete("/:id", financialLimiter, async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const teamId = req.params.id as string;

    if (!UUID_RE.test(teamId)) {
      res.status(400).json({ error: "Invalid team ID format" });
      return;
    }

    const result = await teamRepo.deleteTeam(teamId, userId);
    log.info("team deleted", { userId, teamId, refundedCents: result.refundedCents });

    res.json({
      deleted: true,
      refundedCents: result.refundedCents,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Only the team owner")) {
      res.status(403).json({ error: msg });
      return;
    }
    if (msg.includes("Cannot delete")) {
      res.status(400).json({ error: msg });
      return;
    }
    if (msg.includes("not found")) {
      res.status(404).json({ error: msg });
      return;
    }
    log.error("delete team failed", { error: msg });
    res.status(500).json({ error: "Failed to delete team" });
  }
});

// ─── Team Wallet ─────────────────────────────────────────────────────

// POST /api/teams/:id/wallet/fund — Fund from personal wallet
router.post("/:id/wallet/fund", financialLimiter, async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;

    // Require verified email before funding team wallets
    const fundingUser = await userRepo.findUserById(userId);
    if (!fundingUser || !fundingUser.email_verified) {
      res.status(403).json({ error: "Email verification required before funding team wallets", code: "EMAIL_NOT_VERIFIED" });
      return;
    }

    const teamId = req.params.id as string;
    const amountCents = parseInt(req.body.amountCents, 10);

    if (!UUID_RE.test(teamId)) {
      res.status(400).json({ error: "Invalid team ID format" });
      return;
    }

    if (!Number.isFinite(amountCents) || amountCents < 100 || amountCents > 1_000_000) {
      res.status(400).json({ error: "Amount must be between 100 and 1,000,000 cents ($1 - $10,000)" });
      return;
    }

    const tx = await teamRepo.fundTeamWallet(userId, teamId, amountCents);
    log.info("team wallet funded", { userId, teamId, amountCents });

    res.json({
      transaction: {
        id: tx.id,
        walletId: tx.wallet_id,
        type: tx.type,
        amountCents: tx.amount_cents,
        description: tx.description,
        createdAt: tx.created_at,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Insufficient balance") || msg.includes("balance cap")) {
      res.status(400).json({ error: msg });
      return;
    }
    if (msg.includes("not found") || msg.includes("not active")) {
      res.status(404).json({ error: msg });
      return;
    }
    if (msg.includes("Only team owners")) {
      res.status(403).json({ error: msg });
      return;
    }
    log.error("fund team wallet failed", { error: msg });
    res.status(500).json({ error: "Failed to fund team wallet" });
  }
});

// GET /api/teams/:id/wallet/transactions — Transaction history
router.get("/:id/wallet/transactions", async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const teamId = req.params.id as string;

    if (!UUID_RE.test(teamId)) {
      res.status(400).json({ error: "Invalid team ID format" });
      return;
    }

    const limit = Math.min(Math.max(1, parseInt(req.query.limit as string, 10) || 50), 100);
    const offset = Math.max(0, parseInt(req.query.offset as string, 10) || 0);

    const transactions = await teamRepo.getTeamWalletTransactions(teamId, userId, limit, offset);

    res.json({
      transactions: transactions.map((tx) => ({
        id: tx.id,
        walletId: tx.wallet_id,
        type: tx.type,
        amountCents: tx.amount_cents,
        description: tx.description,
        createdAt: tx.created_at,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Not a member")) {
      res.status(403).json({ error: msg });
      return;
    }
    log.error("get team wallet transactions failed", { error: msg });
    res.status(500).json({ error: "Failed to get transactions" });
  }
});

// ─── Members ─────────────────────────────────────────────────────────

// GET /api/teams/:id/members — List members
router.get("/:id/members", async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const teamId = req.params.id as string;

    if (!UUID_RE.test(teamId)) {
      res.status(400).json({ error: "Invalid team ID format" });
      return;
    }

    const members = await teamRepo.listMembers(teamId, userId);

    res.json({
      members: members.map((m) => ({
        id: m.id,
        teamId: m.team_id,
        userId: m.user_id,
        role: m.role,
        email: m.email,
        joinedAt: m.joined_at,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Not a member")) {
      res.status(403).json({ error: msg });
      return;
    }
    log.error("list team members failed", { error: msg });
    res.status(500).json({ error: "Failed to list members" });
  }
});

// POST /api/teams/:id/members — Direct add by email
router.post("/:id/members", async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;

    // Require email verification before adding team members
    const adder = await userRepo.findUserById(userId);
    if (!adder || !adder.email_verified) {
      res.status(403).json({ error: "Email verification required before adding team members", code: "EMAIL_NOT_VERIFIED" });
      return;
    }

    const teamId = req.params.id as string;
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const role = req.body.role ?? "member";

    if (!UUID_RE.test(teamId)) {
      res.status(400).json({ error: "Invalid team ID format" });
      return;
    }

    if (!isValidEmail(email)) {
      res.status(400).json({ error: "Invalid email address" });
      return;
    }

    if (role !== "member" && role !== "admin") {
      res.status(400).json({ error: "Role must be 'member' or 'admin'" });
      return;
    }

    // Look up user by email — reject suspended/deleted users
    const targetUser = await userRepo.findUserByEmail(email);
    if (!targetUser || targetUser.status !== "active") {
      res.status(404).json({ error: "No active user found with that email" });
      return;
    }

    const member = await teamRepo.addMember(teamId, userId, targetUser.id, role);
    log.info("team member added", { userId, teamId, targetUserId: targetUser.id, role });

    res.status(201).json({
      id: member.id,
      teamId: member.team_id,
      userId: member.user_id,
      role: member.role,
      joinedAt: member.joined_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Only team owners") || msg.includes("Cannot add a second owner")) {
      res.status(403).json({ error: msg });
      return;
    }
    if (msg.includes("maximum member count")) {
      res.status(409).json({ error: msg });
      return;
    }
    if (msg.includes("not found") || msg.includes("not active")) {
      res.status(404).json({ error: msg });
      return;
    }
    if (msg.includes("duplicate key") || msg.includes("already exists")) {
      res.status(409).json({ error: "User is already a member of this team" });
      return;
    }
    log.error("add team member failed", { error: msg });
    res.status(500).json({ error: "Failed to add member" });
  }
});

// PATCH /api/teams/:id/members/:userId — Update member role (owner only)
router.patch("/:id/members/:userId", async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const teamId = req.params.id as string;
    const targetUserId = req.params.userId as string;
    const role = req.body.role;

    if (!UUID_RE.test(teamId)) {
      res.status(400).json({ error: "Invalid team ID format" });
      return;
    }

    if (!UUID_RE.test(targetUserId)) {
      res.status(400).json({ error: "Invalid user ID format" });
      return;
    }

    if (role !== "member" && role !== "admin") {
      res.status(400).json({ error: "Role must be 'member' or 'admin'" });
      return;
    }

    const member = await teamRepo.updateMemberRole(teamId, userId, targetUserId, role);
    log.info("team member role updated", { userId, teamId, targetUserId, role });

    res.json({
      id: member.id,
      teamId: member.team_id,
      userId: member.user_id,
      role: member.role,
      joinedAt: member.joined_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Only the team owner") || msg.includes("Cannot assign owner") || msg.includes("Cannot change your own")) {
      res.status(403).json({ error: msg });
      return;
    }
    if (msg.includes("not found") || msg.includes("is the owner")) {
      res.status(404).json({ error: msg });
      return;
    }
    log.error("update team member role failed", { error: msg });
    res.status(500).json({ error: "Failed to update member role" });
  }
});

// DELETE /api/teams/:id/members/:userId — Remove member
router.delete("/:id/members/:userId", async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const teamId = req.params.id as string;
    const targetUserId = req.params.userId as string;

    if (!UUID_RE.test(teamId)) {
      res.status(400).json({ error: "Invalid team ID format" });
      return;
    }

    if (!UUID_RE.test(targetUserId)) {
      res.status(400).json({ error: "Invalid user ID format" });
      return;
    }

    await teamRepo.removeMember(teamId, userId, targetUserId);
    log.info("team member removed", { userId, teamId, targetUserId });

    res.status(204).end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Only team owners") || msg.includes("Cannot remove the team owner") || msg.includes("Admins cannot remove")) {
      res.status(403).json({ error: msg });
      return;
    }
    if (msg.includes("not found")) {
      res.status(404).json({ error: msg });
      return;
    }
    log.error("remove team member failed", { error: msg });
    res.status(500).json({ error: "Failed to remove member" });
  }
});

// ─── Invites ─────────────────────────────────────────────────────────

// POST /api/teams/:id/invites — Create invite
router.post("/:id/invites", inviteLimiter, async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const teamId = req.params.id as string;
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const role = req.body.role ?? "member";

    if (!UUID_RE.test(teamId)) {
      res.status(400).json({ error: "Invalid team ID format" });
      return;
    }

    if (!isValidEmail(email)) {
      res.status(400).json({ error: "Invalid email address" });
      return;
    }

    if (role !== "member" && role !== "admin") {
      res.status(400).json({ error: "Role must be 'member' or 'admin'" });
      return;
    }

    // Require verified email before sending team invites
    // (also reuse this lookup for the email notification below)
    const inviter = await userRepo.findUserById(userId);
    if (!inviter || !inviter.email_verified) {
      res.status(403).json({ error: "Email verification required before sending team invites", code: "EMAIL_NOT_VERIFIED" });
      return;
    }

    // Generate invite token
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const invite = await teamRepo.createInvite(teamId, userId, email, role, tokenHash, expiresAt);

    // Build invite URL and send email
    const APP_URL = process.env["APP_URL"] || "http://localhost:5173";
    const inviteUrl = `${APP_URL}/teams/invite?token=${rawToken}`;

    // Use inviter email for the email notification (already fetched above for verification check)
    const inviterEmail = inviter.email ?? "A team member";

    // Get team name for the email
    const team = await teamRepo.getTeam(teamId, userId);
    const teamName = team?.name ?? "a team";

    // Send invite email (best-effort, don't fail the request)
    try {
      await sendTeamInviteEmail(email, teamName, inviterEmail, inviteUrl);
    } catch (emailErr) {
      log.warn("failed to send team invite email", {
        error: emailErr instanceof Error ? emailErr.message : String(emailErr),
        teamId,
        email,
      });
    }

    log.info("team invite created", { userId, teamId, email, inviteId: invite.id });

    res.status(201).json({
      id: invite.id,
      teamId: invite.team_id,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expires_at,
      createdAt: invite.created_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Only team owners")) {
      res.status(403).json({ error: msg });
      return;
    }
    if (msg.includes("already a member")) {
      res.status(409).json({ error: msg });
      return;
    }
    if (msg.includes("Pending invite already exists")) {
      res.status(409).json({ error: msg });
      return;
    }
    if (msg.includes("Cannot invite as owner")) {
      res.status(400).json({ error: msg });
      return;
    }
    log.error("create team invite failed", { error: msg });
    res.status(500).json({ error: "Failed to create invite" });
  }
});

// GET /api/teams/:id/invites — List pending invites
router.get("/:id/invites", async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const teamId = req.params.id as string;

    if (!UUID_RE.test(teamId)) {
      res.status(400).json({ error: "Invalid team ID format" });
      return;
    }

    const invites = await teamRepo.listInvites(teamId, userId);

    res.json({
      invites: invites.map((inv) => ({
        id: inv.id,
        teamId: inv.team_id,
        email: inv.email,
        role: inv.role,
        invitedBy: inv.invited_by,
        expiresAt: inv.expires_at,
        createdAt: inv.created_at,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Not a member")) {
      res.status(403).json({ error: msg });
      return;
    }
    log.error("list team invites failed", { error: msg });
    res.status(500).json({ error: "Failed to list invites" });
  }
});

// DELETE /api/teams/:id/invites/:inviteId — Cancel invite
router.delete("/:id/invites/:inviteId", async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const teamId = req.params.id as string;
    const inviteId = req.params.inviteId as string;

    if (!UUID_RE.test(teamId)) {
      res.status(400).json({ error: "Invalid team ID format" });
      return;
    }

    if (!UUID_RE.test(inviteId)) {
      res.status(400).json({ error: "Invalid invite ID format" });
      return;
    }

    await teamRepo.cancelInvite(teamId, userId, inviteId);
    log.info("team invite cancelled", { userId, teamId, inviteId });

    res.status(204).end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Only team owners")) {
      res.status(403).json({ error: msg });
      return;
    }
    if (msg.includes("not found") || msg.includes("already accepted")) {
      res.status(404).json({ error: msg });
      return;
    }
    log.error("cancel team invite failed", { error: msg });
    res.status(500).json({ error: "Failed to cancel invite" });
  }
});

// POST /api/teams/invites/:token/accept — Accept invite
// Rate limit invite acceptance (DB writes on every attempt)
router.post("/invites/:token/accept", inviteLimiter, async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;

    // Verify email before allowing team join (prevents unverified accounts from accessing team resources)
    const invitingUser = await userRepo.findUserById(userId);
    if (!invitingUser || !invitingUser.email_verified) {
      res.status(403).json({ error: "Email verification required before joining a team", code: "EMAIL_NOT_VERIFIED" });
      return;
    }
    const token = req.params.token as string;

    if (typeof token !== "string" || token.length !== 64 || !/^[0-9a-f]+$/i.test(token)) {
      res.status(400).json({ error: "Invalid invite token format" });
      return;
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const member = await teamRepo.acceptInvite(tokenHash, userId);

    log.info("team invite accepted", { userId, teamId: member.team_id });

    res.json({
      id: member.id,
      teamId: member.team_id,
      userId: member.user_id,
      role: member.role,
      joinedAt: member.joined_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found") || msg.includes("already accepted")) {
      res.status(404).json({ error: msg });
      return;
    }
    if (msg.includes("expired")) {
      res.status(410).json({ error: msg });
      return;
    }
    if (msg.includes("Already a member")) {
      res.status(409).json({ error: msg });
      return;
    }
    if (msg.includes("maximum member count")) {
      res.status(409).json({ error: msg });
      return;
    }
    if (msg.includes("not active")) {
      res.status(404).json({ error: msg });
      return;
    }
    log.error("accept team invite failed", { error: msg });
    res.status(500).json({ error: "Failed to accept invite" });
  }
});

// ─── Team API Keys ───────────────────────────────────────────────────

// POST /api/teams/:id/keys — Create team API key
router.post("/:id/keys", financialLimiter, async (req, res) => {
  try {
    if (refusedBySwitch(res, "api_keys")) return;
    const { userId } = (req as unknown as AuthenticatedRequest).user;

    // Require verified email before creating team API keys
    const keyCreator = await userRepo.findUserById(userId);
    if (!keyCreator || !keyCreator.email_verified) {
      res.status(403).json({ error: "Email verification required before creating team API keys", code: "EMAIL_NOT_VERIFIED" });
      return;
    }

    const teamId = req.params.id as string;
    const label = sanitizeString(typeof req.body.label === "string" ? req.body.label : "", 100);

    if (!UUID_RE.test(teamId)) {
      res.status(400).json({ error: "Invalid team ID format" });
      return;
    }

    if (!label || label.length > 100) {
      res.status(400).json({ error: "Label must be 1-100 characters" });
      return;
    }

    const { raw, hash, prefix } = generateApiKey();
    const apiKey = await teamRepo.createTeamApiKey(teamId, userId, hash, prefix, label);

    log.info("team API key created", { userId, teamId, keyId: apiKey.id, prefix });

    // Return the raw key — this is the ONLY time it is shown
    res.status(201).json({
      key: raw,
      id: apiKey.id,
      prefix: apiKey.key_prefix,
      label: apiKey.label,
      createdAt: apiKey.created_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Only team owners")) {
      res.status(403).json({ error: msg });
      return;
    }
    if (msg.includes("not found") || msg.includes("not active")) {
      res.status(404).json({ error: msg });
      return;
    }
    log.error("create team API key failed", { error: msg });
    res.status(500).json({ error: "Failed to create team API key" });
  }
});

// GET /api/teams/:id/keys — List team API keys
router.get("/:id/keys", async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const teamId = req.params.id as string;

    if (!UUID_RE.test(teamId)) {
      res.status(400).json({ error: "Invalid team ID format" });
      return;
    }

    const keys = await teamRepo.listTeamApiKeys(teamId, userId);

    res.json({
      keys: keys.map((k) => ({
        id: k.id,
        userId: k.user_id,
        prefix: k.key_prefix,
        label: k.label,
        teamId: k.team_id,
        createdAt: k.created_at,
        revokedAt: k.revoked_at,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Not a member")) {
      res.status(403).json({ error: msg });
      return;
    }
    log.error("list team API keys failed", { error: msg });
    res.status(500).json({ error: "Failed to list team API keys" });
  }
});

// DELETE /api/teams/:id/keys/:keyId — Revoke team API key
router.delete("/:id/keys/:keyId", financialLimiter, async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const teamId = req.params.id as string;
    const keyId = (req.params as Record<string, string>).keyId;

    if (!UUID_RE.test(teamId)) {
      res.status(400).json({ error: "Invalid team ID format" });
      return;
    }
    if (!UUID_RE.test(keyId)) {
      res.status(400).json({ error: "Invalid key ID format" });
      return;
    }

    const revoked = await teamRepo.revokeTeamApiKey(teamId, userId, keyId);
    if (!revoked) {
      res.status(404).json({ error: "API key not found or already revoked" });
      return;
    }

    log.info("team API key revoked", { userId, teamId, keyId });
    res.status(204).end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Only team owners")) {
      res.status(403).json({ error: "Only team owners or admins can revoke team API keys" });
      return;
    }
    log.error("revoke team API key failed", { error: msg });
    res.status(500).json({ error: "Failed to revoke team API key" });
  }
});

export default router;
