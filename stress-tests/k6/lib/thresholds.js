/**
 * Standard thresholds for local and production modes.
 */

export const LOCAL_THRESHOLDS = {
  http_req_duration: ["p(95)<500", "p(99)<2000"],
  dominusnode_proxy_success_rate: ["rate>0.99"],
  dominusnode_proxy_latency: ["p(95)<500", "p(99)<2000"],
  http_req_failed: ["rate<0.01"],
};

export const PRODUCTION_THRESHOLDS = {
  http_req_duration: ["p(95)<2000", "p(99)<5000"],
  dominusnode_proxy_success_rate: ["rate>0.99"],
  dominusnode_proxy_latency: ["p(95)<2000", "p(99)<5000"],
  http_req_failed: ["rate<0.01"],
};

export function getThresholds(mode) {
  return mode === "production" ? PRODUCTION_THRESHOLDS : LOCAL_THRESHOLDS;
}

/**
 * Build k6 scenarios config for ramping through VU levels.
 */
export function buildRampingScenario(name, vuLevels, durationPerLevel) {
  const stages = [];
  for (const vus of vuLevels) {
    // Ramp up to level
    stages.push({ duration: "5s", target: vus });
    // Hold at level
    stages.push({ duration: durationPerLevel, target: vus });
  }
  // Ramp down
  stages.push({ duration: "5s", target: 0 });

  return {
    [name]: {
      executor: "ramping-vus",
      startVUs: 0,
      stages,
      gracefulRampDown: "10s",
    },
  };
}

/**
 * Build k6 constant VU scenario.
 */
export function buildConstantScenario(name, vus, duration) {
  return {
    [name]: {
      executor: "constant-vus",
      vus,
      duration,
    },
  };
}

/**
 * Build k6 shared-iterations scenario (for one-shot tests like large downloads).
 */
export function buildSharedIterationsScenario(name, vus, iterations) {
  return {
    [name]: {
      executor: "shared-iterations",
      vus,
      iterations,
      maxDuration: "10m",
    },
  };
}
