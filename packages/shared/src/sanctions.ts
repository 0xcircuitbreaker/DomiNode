/**
 * OFAC Sanctioned Countries — US-based proxy services are prohibited
 * from serving users in these jurisdictions.
 *
 * Tier 1: Comprehensively sanctioned (legally required to block)
 * Tier 2: Functionally near-comprehensive (strongly recommended)
 *
 * Uses ISO 3166-1 alpha-2 country codes.
 */

export interface SanctionedCountry {
  code: string;
  name: string;
  program: string;
}

/** Comprehensively sanctioned — must block */
export const SANCTIONED_COUNTRIES: SanctionedCountry[] = [
  { code: "CU", name: "Cuba", program: "Cuban Assets Control Regulations (31 CFR Part 515)" },
  { code: "IR", name: "Iran", program: "Iranian Transactions and Sanctions Regulations (31 CFR Part 560)" },
  { code: "KP", name: "North Korea", program: "North Korea Sanctions Regulations (31 CFR Part 510)" },
  { code: "RU", name: "Russia", program: "Russian Harmful Foreign Activities Sanctions (31 CFR Part 587; EOs 14024, 14071)" },
  { code: "SY", name: "Syria", program: "Syria Sanctions (31 CFR Part 542)" },
];

/**
 * Sanctioned regions within otherwise non-sanctioned countries.
 * These require IP geolocation at the region level.
 * For simplicity in the proxy gateway, we block at the country level
 * for these (Ukraine is NOT blocked — only specific occupied regions).
 * Webshare country targeting uses country codes, so we note these
 * for reference but block via the country code where feasible.
 */
export const SANCTIONED_REGIONS = [
  { country: "UA", region: "Crimea", program: "EO 13685 (31 CFR Part 589)" },
  { country: "UA", region: "Donetsk People's Republic", program: "EO 14065 (31 CFR Part 589)" },
  { country: "UA", region: "Luhansk People's Republic", program: "EO 14065 (31 CFR Part 589)" },
];

/** Set of blocked country codes for fast lookup */
export const BLOCKED_COUNTRY_CODES = new Set(
  SANCTIONED_COUNTRIES.map((c) => c.code.toUpperCase()),
);

/** Check if a country code is sanctioned */
export function isBlockedCountry(countryCode: string): boolean {
  return BLOCKED_COUNTRY_CODES.has(countryCode.toUpperCase());
}
