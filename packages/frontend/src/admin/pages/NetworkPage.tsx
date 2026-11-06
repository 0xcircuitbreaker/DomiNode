import { useState } from "react";
import { useApi } from "../../hooks/useApi";
import { adminApi, PERIODS, type Period } from "../../api/admin";
import { fmtGb, fmtInt, fmtMoney } from "../../lib/format";
import { Card, DataTable, ErrorBox, Kpi, Loading, PageHeader, Segmented } from "../components/ui";
import { RankBars } from "../components/charts";

type Metric = "online" | "traffic";

function countryName(code: string): string {
  if (code === "unknown" || !/^[A-Z]{2}$/.test(code)) return "Unknown";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export default function NetworkPage() {
  const [period, setPeriod] = useState<Period>("30d");
  const [metric, setMetric] = useState<Metric>("online");
  const geo = useApi(() => adminApi.geo({ period }), [period]);
  const g = geo.data;

  const countries = g?.byCountry ?? [];
  const bars = [...countries]
    .map((c) => ({ name: c.country === "unknown" ? "??" : c.country, value: metric === "online" ? c.onlineNodes : Number(c.gb) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 15);

  return (
    <div>
      <PageHeader title="Network" subtitle="Node counts are current; traffic and revenue use the selected period."
        actions={<Segmented label="Period" value={period} options={PERIODS} onChange={setPeriod} />} />
      <ErrorBox error={geo.error} onRetry={geo.refetch} />
      {geo.loading && !g ? <Loading /> : g && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Countries" value={fmtInt(countries.filter((c) => c.country !== "unknown" && c.nodes > 0).length)} />
            <Kpi label="ASNs (top 100)" value={fmtInt(g.byAsn.length)} />
            <Kpi label="Online nodes" value={fmtInt(countries.reduce((s, c) => s + c.onlineNodes, 0))} />
            <Kpi label={`Traffic ${period}`} value={fmtGb(countries.reduce((s, c) => s + Number(c.gb), 0))} />
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
            <Card className="xl:col-span-2" title="Top countries"
              actions={<Segmented label="Metric" value={metric} options={["online", "traffic"] as const} onChange={setMetric} />}>
              <RankBars data={bars} label={metric === "online" ? "Online nodes" : "Traffic GB"} color={metric === "online" ? 0 : 2}
                format={metric === "online" ? (v) => fmtInt(v) : (v) => fmtGb(v)} />
            </Card>
            <Card className="xl:col-span-3" title="By country" bodyClassName="pt-0">
              <DataTable caption="Nodes and traffic by country" rowKey={(c) => c.country} rows={countries}
                columns={[
                  { key: "c", header: "Country", render: (c) => <span><span className="font-mono text-xs text-slate-400">{c.country === "unknown" ? "??" : c.country}</span> {countryName(c.country)}</span> },
                  { key: "n", header: "Nodes", align: "right", render: (c) => fmtInt(c.nodes) },
                  { key: "a", header: "Active", align: "right", render: (c) => fmtInt(c.activeNodes) },
                  { key: "o", header: "Online", align: "right", render: (c) => fmtInt(c.onlineNodes) },
                  { key: "gb", header: "Traffic", align: "right", render: (c) => fmtGb(c.gb) },
                  { key: "g", header: "Gross", align: "right", render: (c) => fmtMoney(c.gross) },
                  { key: "e", header: "Node earnings", align: "right", render: (c) => fmtMoney(c.nodeEarnings) },
                ]} />
            </Card>
          </div>
          <Card title="By ASN (top 100 by traffic)" className="mt-4" bodyClassName="pt-0">
            <DataTable caption="Nodes and traffic by ASN" rowKey={(a) => String(a.asn)} rows={g.byAsn}
              columns={[
                { key: "asn", header: "ASN", render: (a) => (a.asn === null ? "Unknown" : `AS${a.asn}`) },
                { key: "n", header: "Nodes", align: "right", render: (a) => fmtInt(a.nodes) },
                { key: "a", header: "Active", align: "right", render: (a) => fmtInt(a.activeNodes) },
                { key: "o", header: "Online", align: "right", render: (a) => fmtInt(a.onlineNodes) },
                { key: "gb", header: "Traffic", align: "right", render: (a) => fmtGb(a.gb) },
                { key: "g", header: "Gross", align: "right", render: (a) => fmtMoney(a.gross) },
                { key: "e", header: "Node earnings", align: "right", render: (a) => fmtMoney(a.nodeEarnings) },
              ]} />
          </Card>
        </>
      )}
    </div>
  );
}
