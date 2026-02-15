import * as crypto from "node:crypto";

// ─── TOTP (RFC 6238) ───────────────────────────────────────────────
// Uses HMAC-SHA1 per spec, 6-digit codes, 30-second period, +/-1 window

const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1; // accept codes from +/-1 period

// ─── Secret Generation ─────────────────────────────────────────────

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function toBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return result;
}

export function generateTotpSecret(): { raw: Buffer; base32: string } {
  const raw = crypto.randomBytes(20); // 160-bit per RFC 4226
  return { raw, base32: toBase32(raw) };
}

// ─── AES-256-GCM Encryption ────────────────────────────────────────

function getEncryptionKey(): Buffer {
  const hex = process.env["MFA_ENCRYPTION_KEY"];
  if (!hex || hex.length !== 64) {
    throw new Error("MFA_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

export function encryptTotpSecret(raw: Buffer): { encrypted: string; iv: string } {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(raw), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: Buffer.concat([enc, tag]).toString("base64"),
    iv: iv.toString("base64"),
  };
}

export function decryptTotpSecret(encrypted: string, iv: string): Buffer {
  const key = getEncryptionKey();
  const ivBuf = Buffer.from(iv, "base64");
  const combined = Buffer.from(encrypted, "base64");
  const tag = combined.subarray(combined.length - 16);
  const data = combined.subarray(0, combined.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, ivBuf);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// ─── TOTP Code Generation & Verification ────────────────────────────

function generateCode(secret: Buffer, counter: bigint): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * Verify a TOTP code against a secret.
 * Accepts codes within +/-1 time step to account for clock drift.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @param lastUsedCounter - Optional: reject codes with counter <= this value (replay prevention per RFC 6238 §5.2)
 * @returns The counter value used if verified, or null if rejected. Use the returned counter as `lastUsedCounter` for the next call.
 */
export function verifyTotpCode(secret: Buffer, code: string, nowMs?: number, lastUsedCounter?: bigint): bigint | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = nowMs ?? Date.now();
  const counter = BigInt(Math.floor(now / 1000 / TOTP_PERIOD));
  for (let i = -TOTP_WINDOW; i <= TOTP_WINDOW; i++) {
    const stepCounter = counter + BigInt(i);
    // Replay prevention: reject codes at or below the last accepted counter
    if (lastUsedCounter !== undefined && stepCounter <= lastUsedCounter) continue;
    const expected = generateCode(secret, stepCounter);
    if (crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected))) {
      return stepCounter;
    }
  }
  return null;
}

/**
 * Generate a TOTP code for the current time step (used in tests).
 */
export function generateTotpCode(secret: Buffer, nowMs?: number): string {
  const now = nowMs ?? Date.now();
  const counter = BigInt(Math.floor(now / 1000 / TOTP_PERIOD));
  return generateCode(secret, counter);
}

// ─── OTPAuth URI ────────────────────────────────────────────────────

export function buildTotpUri(base32Secret: string, email: string, issuer = "Dominus Node"): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret: base32Secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ─── Backup Codes ───────────────────────────────────────────────────

const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 8;

export function generateBackupCodes(): { plaintextCodes: string[]; hashes: string[] } {
  const plaintextCodes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    // Generate 8-digit numeric code
    const code = String(crypto.randomInt(0, 10 ** BACKUP_CODE_LENGTH)).padStart(BACKUP_CODE_LENGTH, "0");
    plaintextCodes.push(code);
    hashes.push(hashBackupCode(code));
  }
  return { plaintextCodes, hashes };
}

export function hashBackupCode(code: string): string {
  // Use HMAC-SHA256 with server key to prevent rainbow table attacks on 8-digit codes
  const key = process.env["MFA_ENCRYPTION_KEY"];
  if (!key) {
    throw new Error("MFA_ENCRYPTION_KEY is required for backup code hashing");
  }
  return crypto.createHmac("sha256", key).update(code).digest("hex");
}
