import { SUPPORTED_CRYPTO, type SupportedCrypto } from "./types.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email) && email.length <= 254;
}

export function validatePassword(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters";
  if (password.length > 128) return "Password must be at most 128 characters";
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

export function sanitizeString(input: string, maxLength: number): string {
  return input.trim().slice(0, maxLength);
}
