/**
 * Constants shared across all Dominus Node n8n nodes.
 *
 * @module
 */

/** HTTP methods allowed for proxied fetch (read-only to prevent abuse). */
export const ALLOWED_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Maximum response body length returned to n8n workflows. */
export const MAX_BODY_TRUNCATE = 4000;
