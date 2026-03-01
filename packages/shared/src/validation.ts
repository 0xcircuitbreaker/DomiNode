import { SUPPORTED_CRYPTO, type SupportedCrypto } from "./types.js";

// Rejects double dots, leading/trailing dots in local/domain, and very short emails
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

// Common disposable/temporary email domains used for mass signup abuse.
// This is not exhaustive — a DNS-based check is better for production,
// but this blocks the most common offenders at zero cost.
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "10minutemail.com", "tempmail.com", "throwaway.email", "guerrillamail.com",
  "guerrillamail.net", "guerrillamail.org", "sharklasers.com", "grr.la",
  "guerrillamailblock.com", "pokemail.net", "spam4.me", "dispostable.com",
  "mailinator.com", "maildrop.cc", "yopmail.com", "yopmail.fr", "yopmail.net",
  "trashmail.com", "trashmail.me", "trashmail.net", "tempr.email",
  "temp-mail.org", "tempail.com", "mohmal.com", "getnada.com",
  "emailondeck.com", "mailnesia.com", "fakeinbox.com", "mailnull.com",
  "spamgourmet.com", "mytemp.email", "tmpmail.net", "tmpmail.org",
  "burnermail.io", "discard.email", "discardmail.com", "harakirimail.com",
  "mailexpire.com", "meltmail.com", "mintemail.com", "mt2015.com",
  "nada.email", "throwam.com", "tmail.ws", "trash-mail.com",
  "wegwerfmail.de", "wegwerfmail.net", "zoemail.org", "mailcatch.com",
  "inboxkitten.com", "dropmail.me", "crazymailing.com",
]);

export function isDisposableEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}

export function isValidEmail(email: string): boolean {
  if (email.length < 5 || email.length > 254) return false;
  // Reject double dots in local part or domain
  if (email.includes("..")) return false;
  // Reject leading dot in local part
  const [localPart] = email.split("@");
  if (localPart.startsWith(".") || localPart.endsWith(".")) return false;
  return EMAIL_RE.test(email);
}

const COMMON_PASSWORDS = new Set([
  "password", "12345678", "123456789", "1234567890", "qwerty123",
  "password1", "iloveyou", "sunshine1", "princess1", "football1",
  "charlie1", "trustno1", "welcome1", "shadow12", "monkey123",
  "dragon12", "master12", "letmein1", "abcdefgh", "qwertyui",
]);

export function validatePassword(password: string, email?: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters";
  if (password.length > 128) return "Password must be at most 128 characters";

  // Check against common passwords
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return "Password is too common. Please choose a stronger password";
  }

  // Reject passwords containing the email username
  if (email) {
    const username = email.split("@")[0].toLowerCase();
    if (username.length >= 3 && password.toLowerCase().includes(username)) {
      return "Password must not contain your email username";
    }
  }

  // Require at least 2 character classes
  let classes = 0;
  if (/[a-z]/.test(password)) classes++;
  if (/[A-Z]/.test(password)) classes++;
  if (/[0-9]/.test(password)) classes++;
  if (/[^a-zA-Z0-9]/.test(password)) classes++;
  if (classes < 2) {
    return "Password must contain at least 2 of: lowercase, uppercase, digits, symbols";
  }

  return null;
}

export function validateTopupAmount(cents: number): string | null {
  if (!Number.isInteger(cents)) return "Amount must be a whole number of cents";
  if (cents < 500) return "Minimum top-up is $5.00";
  if (cents > 100_000) return "Maximum top-up is $1,000.00";
  return null;
}

export function isValidCryptoCurrency(currency: string): currency is SupportedCrypto {
  return (SUPPORTED_CRYPTO as readonly string[]).includes(currency.toLowerCase());
}

// Strip control characters, zero-width characters, and RTL overrides
// to prevent log injection, display spoofing, and invisible payload insertion
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF]/g;

export function sanitizeString(input: string, maxLength: number): string {
  return input.replace(CONTROL_CHARS_RE, "").trim().slice(0, maxLength);
}

// ─── Geo-Targeting Validation ──────────────────────────────────────

export function validateState(state: string): string | null {
  if (!state) return null; // empty is valid (no targeting)
  if (!/^[a-z]{2,30}$/.test(state)) {
    return "State must be 2-30 lowercase letters";
  }
  return null;
}

export function validateCity(city: string): string | null {
  if (!city) return null;
  if (!/^[a-z]{2,50}$/.test(city)) {
    return "City must be 2-50 lowercase letters";
  }
  return null;
}

export function validateAsn(asn: number): string | null {
  if (!Number.isInteger(asn) || asn < 1 || asn > 4_294_967_295) {
    return "ASN must be an integer between 1 and 4,294,967,295";
  }
  return null;
}
