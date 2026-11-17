import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Guards infra/observability against drift: every metric an alert or
 * dashboard panel references must be emitted by the gateway or API code.
 */
const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const emittingSource = [
  "packages/proxy-gateway/src/server.ts",
  "packages/proxy-gateway/src/stats.ts",
  "packages/dashboard/src/server.ts",
].map(read).join("\n");

// Prometheus synthetic series, not emitted by our code.
const SYNTHETIC = new Set(["up"]);
const PROMQL_WORDS = new Set([
  "and", "or", "unless", "by", "without", "on", "ignoring", "group_left", "group_right",
  "bool", "offset", "sum", "avg", "min", "max", "count", "topk", "bottomk", "quantile",
  "stddev", "stdvar", "count_values",
]);

/** Metric names in a PromQL expression (identifiers that are not functions, keywords, labels or durations). */
function metricNames(expr: string): string[] {
  const stripped = expr
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // string literals
    .replace(/\{[^}]*\}/g, "") // label matchers
    .replace(/\[[^\]]*\]/g, "") // range selectors
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ""); // label lists
  const out = new Set<string>();
  const re = /\b([a-zA-Z_:][a-zA-Z0-9_:]*)\b(\s*\()?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const [, name, call] = m;
    if (call) continue; // function call
    if (PROMQL_WORDS.has(name)) continue;
    if (/^\d/.test(name) || /^e\d+$/.test(name)) continue;
    out.add(name);
  }
  return [...out];
}

function alertExprs(yaml: string): string[] {
  const lines = yaml.split("\n");
  const exprs: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)expr:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2].trim() === "|" || m[2].trim() === ">") {
      const indent = m[1].length;
      const body: string[] = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === "" || lines[i + 1].search(/\S/) > indent)) {
        body.push(lines[++i].trim());
      }
      exprs.push(body.join(" "));
    } else {
      exprs.push(m[2]);
    }
  }
  return exprs;
}

function assertEmitted(names: string[]) {
  for (const n of names) {
    if (SYNTHETIC.has(n)) continue;
    expect(emittingSource, `metric ${n} is not emitted by gateway/api code`).toMatch(
      new RegExp(`\\b${n}\\b`),
    );
  }
}

describe("observability kit", () => {
  it("metricNames extracts metric identifiers only", () => {
    expect(
      metricNames('rate(a_total[5m]) / clamp_min(rate(b_total{x="y"}[5m]), 0.01) > 1.5e9 and sum by (job) (up)'),
    ).toEqual(["a_total", "b_total", "up"]);
  });

  it("alerts.yml only references emitted metrics", () => {
    const yaml = read("infra/observability/alerts.yml");
    const exprs = alertExprs(yaml);
    expect(exprs.length).toBe((yaml.match(/^\s*- alert:/gm) ?? []).length);
    expect(exprs.length).toBeGreaterThan(5);
    for (const e of exprs) {
      const names = metricNames(e);
      expect(names.length, `no metric in ${e}`).toBeGreaterThan(0);
      assertEmitted(names);
    }
  });

  it("every alert links a runbook section that exists in OBSERVABILITY.md", () => {
    const yaml = read("infra/observability/alerts.yml");
    const doc = read("docs/agent-network/OBSERVABILITY.md").toLowerCase();
    const alerts = [...yaml.matchAll(/- alert:\s*(\w+)/g)].map((m) => m[1]);
    for (const a of alerts) {
      expect(yaml).toContain(`OBSERVABILITY.md#${a.toLowerCase()}`);
      expect(doc, `missing runbook heading for ${a}`).toMatch(new RegExp(`^###\\s+${a.toLowerCase()}\\s*$`, "m"));
    }
  });

  it("grafana dashboard only references emitted metrics", () => {
    const dash = JSON.parse(read("infra/observability/grafana-dashboard.json")) as {
      panels: { title: string; targets?: { expr: string }[] }[];
    };
    const exprs = dash.panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr));
    expect(exprs.length).toBeGreaterThan(5);
    for (const e of exprs) assertEmitted(metricNames(e));
  });

  it("prometheus.yml uses placeholder hosts and loads the alert rules", () => {
    const prom = read("infra/observability/prometheus.yml");
    expect(prom).toContain("/etc/prometheus/alerts.yml");
    expect(prom).toMatch(/credentials_file:/);
    const hosts = [...prom.matchAll(/"([a-z0-9.-]+):\d+"/gi)].map((m) => m[1]);
    for (const h of hosts) expect(h === "127.0.0.1" || h.endsWith("example.org"), h).toBe(true);
  });
});
