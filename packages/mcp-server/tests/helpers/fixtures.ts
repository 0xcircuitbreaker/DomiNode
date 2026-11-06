export const PRICING = {
  currency: "USD",
  unit: "musd_per_gb",
  prices: [
    { ipClass: "residential", pricePerGbMusd: "500000" },
    { ipClass: "dc", pricePerGbMusd: "200000" },
  ],
  nodeShare: [
    { tier: "Bronze", rank: 1, nodeShareBps: 3000 },
    { tier: "Probation", rank: 0, nodeShareBps: 2500 },
    { tier: "Partner", rank: 5, nodeShareBps: 5000 },
  ],
  maturationHours: 72,
  rails: ["wallet", "x402", "crypto"],
};

export const POLICY = {
  version: 4,
  sha256: "a".repeat(64),
  body: {
    ports: [80, 443],
    plaintext: "opt_in",
    sanctionedCountries: ["CU", "IR", "KP", "RU", "SY"],
    requesterLimits: { reqPerSec: 20, dailySpendMusd: 50000000 },
    nodeDefaults: { maxStreams: 32, maxGbDay: 5 },
    attestation: { minVersion: 1, text: "I operate this node lawfully." },
    denyCategories: [],
    denyDomains: ["bad.example"],
    logRetentionDays: 90,
    nodeCapsPerPrefix: { per32: 2, per24: 8, perAsn: 500 },
    freeTierRelay: false,
  },
  floorGuarantees: ["Ports 22, 25 are always denied."],
};

