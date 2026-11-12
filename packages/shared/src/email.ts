import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { createLogger } from "./logger.js";

const log = createLogger("email");

// ─── Configuration ───────────────────────────────────────────────────

const SMTP_HOST = process.env.SMTP_HOST ?? "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT ?? "587", 10);
const SMTP_USER = process.env.SMTP_USER ?? "";
const SMTP_PASS = process.env.SMTP_PASS ?? "";
// Never a personal address: default to noreply@<DOMINUSNODE_DOMAIN>.
const SMTP_FROM = process.env.SMTP_FROM || `noreply@${process.env.DOMINUSNODE_DOMAIN || "localhost"}`;
const SMTP_SECURE = process.env.SMTP_SECURE === "true"; // TLS on connect (port 465)
const EMAIL_ENABLED = process.env.EMAIL_ENABLED === "true";

const APP_URL = process.env.APP_URL ?? "http://localhost:5173";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!EMAIL_ENABLED || !SMTP_HOST) return null;

  if (!transporter) {
    const ignoreTLS = process.env.SMTP_IGNORE_TLS === "true";
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      ignoreTLS,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
      tls: {
        // Verify TLS certs in production; allow self-signed in dev for local Postfix relay
        rejectUnauthorized: process.env.NODE_ENV === "production"
          ? (process.env.SMTP_REJECT_UNAUTHORIZED !== "false")
          : false,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }
  return transporter;
}

// ─── Send Helper ─────────────────────────────────────────────────────

async function sendEmail(to: string, subject: string, html: string, text: string): Promise<boolean> {
  const t = getTransporter();
  if (!t) {
    // Dev mode: log to console instead of sending
    log.info("email not sent (EMAIL_ENABLED=false or no SMTP_HOST)", {
      to,
      subject,
      textPreview: text.slice(0, 200),
    });
    return true; // Pretend success in dev
  }

  try {
    await t.sendMail({
      from: SMTP_FROM,
      to,
      subject,
      html,
      text,
    });
    log.info("email sent", { to, subject });
    return true;
  } catch (err) {
    log.error("email send failed", {
      to,
      subject,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ─── Email Templates ─────────────────────────────────────────────────

export async function sendVerificationEmail(to: string, token: string): Promise<boolean> {
  const verifyUrl = `${APP_URL}/verify-email?token=${encodeURIComponent(token)}`;

  const subject = "Verify your Dominus Node email";
  const text = [
    "Welcome to Dominus Node!",
    "",
    "Please verify your email address by visiting this link:",
    verifyUrl,
    "",
    "This link expires in 24 hours.",
    "",
    "If you did not create an account, you can safely ignore this email.",
  ].join("\n");

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #818cf8;">Dominus Node</h2>
      <p>Welcome! Please verify your email address:</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(verifyUrl)}" style="background: #4f46e5; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block;">Verify Email</a>
      </p>
      <p style="color: #9ca3af; font-size: 14px;">This link expires in 24 hours.</p>
      <p style="color: #9ca3af; font-size: 14px;">If you did not create an account, you can safely ignore this email.</p>
      <hr style="border: none; border-top: 1px solid #374151; margin: 24px 0;" />
      <p style="color: #6b7280; font-size: 12px;">Dominus Node — Proxy as a Service</p>
    </div>
  `;

  return sendEmail(to, subject, html, text);
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<boolean> {
  const resetUrl = `${APP_URL}/reset-password?token=${encodeURIComponent(token)}`;

  const subject = "Reset your Dominus Node password";
  const text = [
    "Password Reset Request",
    "",
    "You (or someone else) requested a password reset for your Dominus Node account.",
    "",
    "Reset your password by visiting this link:",
    resetUrl,
    "",
    "This link expires in 1 hour.",
    "",
    "If you did not request this, you can safely ignore this email.",
    "Your password will not be changed unless you click the link above.",
  ].join("\n");

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #818cf8;">Dominus Node</h2>
      <p>You requested a password reset for your account.</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(resetUrl)}" style="background: #4f46e5; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block;">Reset Password</a>
      </p>
      <p style="color: #9ca3af; font-size: 14px;">This link expires in 1 hour.</p>
      <p style="color: #9ca3af; font-size: 14px;">If you did not request this, you can safely ignore this email. Your password will not be changed.</p>
      <hr style="border: none; border-top: 1px solid #374151; margin: 24px 0;" />
      <p style="color: #6b7280; font-size: 12px;">Dominus Node — Proxy as a Service</p>
    </div>
  `;

  return sendEmail(to, subject, html, text);
}

export async function sendWaitlistApprovalEmail(to: string): Promise<boolean> {
  const registerUrl = `${APP_URL}/login?mode=register`;

  const subject = "Your Dominus Node alpha slot is ready!";
  const text = [
    "Great news!",
    "",
    "A slot has opened up in the Dominus Node alpha program, and you're in!",
    "",
    "Create your account now:",
    registerUrl,
    "",
    "This slot is available on a first-come, first-served basis.",
    "",
    "If you no longer wish to join, you can safely ignore this email.",
  ].join("\n");

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #818cf8;">Dominus Node</h2>
      <p>Great news! A slot has opened up in the Dominus Node alpha program, and you're in!</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(registerUrl)}" style="background: #4f46e5; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block;">Create Your Account</a>
      </p>
      <p style="color: #9ca3af; font-size: 14px;">This slot is available on a first-come, first-served basis.</p>
      <p style="color: #9ca3af; font-size: 14px;">If you no longer wish to join, you can safely ignore this email.</p>
      <hr style="border: none; border-top: 1px solid #374151; margin: 24px 0;" />
      <p style="color: #6b7280; font-size: 12px;">Dominus Node — Proxy as a Service</p>
    </div>
  `;

  return sendEmail(to, subject, html, text);
}

// ─── Helpers ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export async function sendTeamInviteEmail(
  to: string,
  teamName: string,
  inviterEmail: string,
  inviteUrl: string,
): Promise<boolean> {
  const subject = `You've been invited to join ${teamName} on Dominus Node`;
  const text = [
    `Team Invite`,
    ``,
    `${inviterEmail} has invited you to join the team "${teamName}" on Dominus Node.`,
    ``,
    `Accept the invitation by visiting this link:`,
    inviteUrl,
    ``,
    `This invitation expires in 7 days.`,
    ``,
    `If you don't have an account, you'll need to register first.`,
  ].join("\n");

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #818cf8;">Dominus Node</h2>
      <p><strong>${escapeHtml(inviterEmail)}</strong> has invited you to join the team <strong>"${escapeHtml(teamName)}"</strong>.</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(inviteUrl)}" style="background: #4f46e5; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block;">Accept Invitation</a>
      </p>
      <p style="color: #9ca3af; font-size: 14px;">This invitation expires in 7 days.</p>
      <p style="color: #9ca3af; font-size: 14px;">If you don't have an account, you'll need to register first.</p>
      <hr style="border: none; border-top: 1px solid #374151; margin: 24px 0;" />
      <p style="color: #6b7280; font-size: 12px;">Dominus Node — Proxy as a Service</p>
    </div>
  `;

  return sendEmail(to, subject, html, text);
}

/** Check if email sending is configured */
export function isEmailEnabled(): boolean {
  return EMAIL_ENABLED && !!SMTP_HOST;
}
