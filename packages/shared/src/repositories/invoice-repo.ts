import { query } from "../db.js";
import type { PaymentInvoice, PaymentProvider } from "../types.js";

export async function createInvoice(
  userId: string,
  provider: PaymentProvider,
  externalId: string,
  amountCents: number,
): Promise<PaymentInvoice> {
  // Validate amountCents range to prevent DB overflow / negative invoices
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 2_147_483_647) {
    throw new Error("Invoice amount must be a positive integer within valid range");
  }
  const result = await query<PaymentInvoice>(
    `INSERT INTO payment_invoices (user_id, provider, external_id, amount_cents)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, provider, external_id, amount_cents, status, created_at`,
    [userId, provider, externalId, amountCents],
  );
  return result.rows[0];
}

export async function findInvoice(
  provider: PaymentProvider,
  externalId: string,
): Promise<PaymentInvoice | null> {
  const result = await query<PaymentInvoice>(
    `SELECT id, user_id, provider, external_id, amount_cents, status, created_at FROM payment_invoices
     WHERE provider = $1 AND external_id = $2`,
    [provider, externalId],
  );
  return result.rows[0] ?? null;
}

/**
 * Find an invoice by its internal ID and user ID.
 * Used for payment status polling — ensures users can only query their own invoices.
 */
export async function findInvoiceById(
  invoiceId: string,
  userId: string,
): Promise<PaymentInvoice | null> {
  const result = await query<PaymentInvoice>(
    `SELECT id, user_id, provider, external_id, amount_cents, status, created_at FROM payment_invoices
     WHERE id = $1 AND user_id = $2`,
    [invoiceId, userId],
  );
  return result.rows[0] ?? null;
}

/**
 * Find an invoice by provider + external ID + user ID.
 * Used for PayPal order status polling — ensures users can only query their own invoices.
 */
export async function findInvoiceByExternalId(
  provider: PaymentProvider,
  externalId: string,
  userId: string,
): Promise<PaymentInvoice | null> {
  const result = await query<PaymentInvoice>(
    `SELECT id, user_id, provider, external_id, amount_cents, status, created_at FROM payment_invoices
     WHERE provider = $1 AND external_id = $2 AND user_id = $3`,
    [provider, externalId, userId],
  );
  return result.rows[0] ?? null;
}

export async function completeInvoice(id: string): Promise<boolean> {
  const result = await query(
    `UPDATE payment_invoices
     SET status = 'completed'
     WHERE id = $1 AND status = 'pending'`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Mark a pending invoice as permanently failed.
 * Only transitions pending -> failed.
 * Operator can manually reconcile failed invoices if needed.
 */
export async function failInvoice(invoiceId: string): Promise<boolean> {
  const result = await query(
    `UPDATE payment_invoices SET status = 'failed' WHERE id = $1 AND status = 'pending'`,
    [invoiceId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Mark a completed invoice as failed when wallet credit fails
 * after the invoice was already marked completed. Only transitions
 * completed -> failed. Prevents infinite retry loops.
 * Operator can manually reconcile failed invoices if needed.
 */
export async function markCreditFailed(invoiceId: string): Promise<boolean> {
  const result = await query(
    `UPDATE payment_invoices SET status = 'failed' WHERE id = $1 AND status = 'completed'`,
    [invoiceId],
  );
  return (result.rowCount ?? 0) > 0;
}
