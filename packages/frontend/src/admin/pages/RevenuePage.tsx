import { useMemo, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { adminApi, IP_CLASSES, PERIODS, RAILS, type Bucket, type Period, type Revenue } from "../../api/admin";
import { fmtGb, fmtInt, fmtMoney, fmtUsdCompact, fmtUsdNumber, musdToUsd, shortId, fmtDate } from "../../lib/format";
import { downloadCsv, toCsv } from "../../lib/csv";
import { Card, DataTable, ErrorBox, Kpi, Loading, PageHeader, Pager, Segmented } from "../components/ui";
import { TimeChart } from "../components/charts";

const BUCKETS: Bucket[] = ["hour", "day", "week"];
const RANGES = ["2d", "7d", "30d", "90d", "1y"] as const;
type Range = (typeof RANGES)[number];
const RANGE_DAYS: Record<Range, number> = { "2d": 2, "7d": 7, "30d": 30, "90d": 90, "1y": 365 };
/** Ranges each bucket allows (server: hour ≤31d, day ≤366d, week ≤1098d). */
const BUCKET_RANGES: Record<Bucket, Range[]> = { hour: ["2d", "7d"], day: ["7d", "30d", "90d", "1y"], week: ["30d", "90d", "1y"] };

export function revenueCsv(r: Revenue): string {
  const header = ["bucket_start", "gross_usd", "platform_usd", "node_usd", "gb", "charges",
    ...RAILS.map((x) => `gross_${x}_usd`), ...IP_CLASSES.map((x) => `gross_${x}_usd`)];
  const rows = r.series.map((p) => [p.t, p.gross.usd, p.platform.usd, p.node.usd, p.gb, p.charges,
    ...RAILS.map((x) => p.byRail[x]?.gross.usd ?? "0"), ...IP_CLASSES.map((x) => p.byClass[x]?.gross.usd ?? "0")]);
  return toCsv(header, rows);
}

export default function RevenuePage() {
  const [bucket, setBucket] = useState<Bucket>("day");
  const [range, setRange] = useState<Range>("30d");
  const [period, setPeriod] = useState<Period>("30d");
  const [reqOffset, setReqOffset] = useState(0);
  const [ownOffset, setOwnOffset] = useState(0);

  const { from, to } = useMemo(() => {
    const now = new Date();
    return { to: now.toISOString(), from: new Date(now.getTime() - RANGE_DAYS[range] * 86_400_000).toISOString() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, bucket]);

  const rev = useApi(() => adminApi.revenue({ bucket, from, to }), [bucket, from, to]);
  const req = useApi(() => adminApi.topRequesters({ period, limit: 10, offset: reqOffset }), [period, reqOffset]);
  const own = useApi(() => adminApi.topNodeOwners({ period, limit: 10, offset: ownOffset }), [period, ownOffset]);

  function changeBucket(b: Bucket) {
    setBucket(b);
    if (!BUCKET_RANGES[b].includes(range)) setRange(BUCKET_RANGES[b][0]);
  }

  const xFmt = (t: string) => (bucket === "hour" ? t.slice(5, 13).replace("T", " ") + "h" : t.slice(5, 10));
  const r = rev.data;
  const split = (r?.series ?? []).map((p) => ({ t: p.t, platform: musdToUsd(p.platform.musd), node: musdToUsd(p.node.musd) }));
  const byRail = (r?.series ?? []).map((p) => ({ t: p.t, ...Object.fromEntries(RAILS.map((x) => [x, musdToUsd(p.byRail[x]?.gross.musd)])) }));
  const byClass = (r?.series ?? []).map((p) => ({ t: p.t, ...Object.fromEntries(IP_CLASSES.map((x) => [x, musdToUsd(p.byClass[x]?.gross.musd)])) }));
  const traffic = (r?.series ?? []).map((p) => ({ t: p.t, gb: Number(p.gb) }));
  const activeRails = RAILS.filter((x) => r && Number(r.totals.byRail[x]?.gross.musd ?? 0) > 0);
  const activeClasses = IP_CLASSES.filter((x) => r && Number(r.totals.byClass[x]?.gross.musd ?? 0) > 0);

  return (
    <div>
      <PageHeader title="Revenue" subtitle={r ? `${fmtDate(r.from)} → ${fmtDate(r.to)}` : undefined}
        actions={<>
          <Segmented label="Bucket" value={bucket} options={BUCKETS} onChange={changeBucket} />
          <Segmented label="Range" value={range} options={BUCKET_RANGES[bucket]} onChange={setRange} />
          <button type="button" className="btn-secondary" disabled={!r || r.series.length === 0}
            onClick={() => r && downloadCsv(`revenue-${bucket}-${r.from.slice(0, 10)}-${r.to.slice(0, 10)}.csv`, revenueCsv(r))}>
            Export CSV
          </button>
        </>} />
      <ErrorBox error={rev.error} onRetry={rev.refetch} />

      {r && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Kpi label="Gross" value={fmtMoney(r.totals.gross)} />
          <Kpi label="Platform" value={fmtMoney(r.totals.platform)} />
          <Kpi label="Node share" value={fmtMoney(r.totals.node)} />
          <Kpi label="Traffic" value={fmtGb(r.totals.gb)} />
          <Kpi label="Charges" value={fmtInt(r.totals.charges)} />
        </div>
      )}
      {rev.loading && !r ? <Loading /> : r && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card title="Gross = platform + node share">
            <TimeChart label="Platform and node share per bucket" kind="bar" stacked data={split} xFormat={xFmt}
              series={[{ key: "platform", label: "Platform" }, { key: "node", label: "Node share" }]}
              format={fmtUsdNumber} axisFormat={fmtUsdCompact} />
          </Card>
          <Card title="Traffic (GB)">
            <TimeChart label="Traffic per bucket" kind="area" data={traffic} xFormat={xFmt}
              series={[{ key: "gb", label: "GB", color: 2 }]} format={(v) => fmtGb(v)} axisFormat={(v) => `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })}`} />
          </Card>
          <Card title="Gross by payment rail">
            <TimeChart label="Gross by rail" kind="bar" stacked data={byRail} xFormat={xFmt}
              series={activeRails.map((x) => ({ key: x, label: x, color: RAILS.indexOf(x) }))} format={fmtUsdNumber} axisFormat={fmtUsdCompact} />
          </Card>
          <Card title="Gross by IP class">
            <TimeChart label="Gross by IP class" kind="bar" stacked data={byClass} xFormat={xFmt}
              series={activeClasses.map((x) => ({ key: x, label: x, color: IP_CLASSES.indexOf(x) }))} format={fmtUsdNumber} axisFormat={fmtUsdCompact} />
          </Card>
          <Card title="Totals by rail" bodyClassName="pt-0">
            <DataTable caption="Totals by rail" rowKey={(x) => x} rows={RAILS}
              columns={[
                { key: "rail", header: "Rail", render: (x) => x },
                { key: "gross", header: "Gross", align: "right", render: (x) => fmtMoney(r.totals.byRail[x]?.gross) },
                { key: "node", header: "Node", align: "right", render: (x) => fmtMoney(r.totals.byRail[x]?.node) },
                { key: "gb", header: "Traffic", align: "right", render: (x) => fmtGb(r.totals.byRail[x]?.gb) },
                { key: "c", header: "Charges", align: "right", render: (x) => fmtInt(r.totals.byRail[x]?.charges) },
              ]} />
          </Card>
          <Card title="Totals by IP class" bodyClassName="pt-0">
            <DataTable caption="Totals by IP class" rowKey={(x) => x} rows={IP_CLASSES}
              columns={[
                { key: "cls", header: "Class", render: (x) => x },
                { key: "gross", header: "Gross", align: "right", render: (x) => fmtMoney(r.totals.byClass[x]?.gross) },
                { key: "node", header: "Node", align: "right", render: (x) => fmtMoney(r.totals.byClass[x]?.node) },
                { key: "gb", header: "Traffic", align: "right", render: (x) => fmtGb(r.totals.byClass[x]?.gb) },
                { key: "c", header: "Charges", align: "right", render: (x) => fmtInt(r.totals.byClass[x]?.charges) },
              ]} />
          </Card>
        </div>
      )}

      <div className="mb-3 mt-6 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Leaders</h2>
        <Segmented label="Leaderboard period" value={period} options={PERIODS} onChange={(p) => { setPeriod(p); setReqOffset(0); setOwnOffset(0); }} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Top requesters (by gross)" bodyClassName="pt-0">
          <ErrorBox error={req.error} />
          <DataTable caption="Top requesters" rowKey={(x) => x.userId} rows={req.data?.items ?? []}
            columns={[
              { key: "who", header: "Agent", render: (x) => <span title={x.userId}>{x.email ?? x.walletAddress ?? shortId(x.userId)}</span> },
              { key: "gross", header: "Gross", align: "right", render: (x) => fmtMoney(x.gross) },
              { key: "gb", header: "Traffic", align: "right", render: (x) => fmtGb(x.gb) },
              { key: "c", header: "Charges", align: "right", render: (x) => fmtInt(x.charges) },
            ]} />
          {req.data && <Pager limit={req.data.limit} offset={req.data.offset} total={req.data.total} onChange={setReqOffset} />}
        </Card>
        <Card title="Top node owners (by earnings)" bodyClassName="pt-0">
          <ErrorBox error={own.error} />
          <DataTable caption="Top node owners" rowKey={(x) => x.userId} rows={own.data?.items ?? []}
            columns={[
              { key: "who", header: "Owner", render: (x) => <span title={x.userId}>{x.email ?? x.walletAddress ?? shortId(x.userId)}</span> },
              { key: "tier", header: "Tier", render: (x) => x.tier ?? "—" },
              { key: "earn", header: "Earnings", align: "right", render: (x) => fmtMoney(x.earnings) },
              { key: "gb", header: "Traffic", align: "right", render: (x) => fmtGb(x.gb) },
              { key: "n", header: "Nodes", align: "right", render: (x) => fmtInt(x.nodesWithTraffic) },
            ]} />
          {own.data && <Pager limit={own.data.limit} offset={own.data.offset} total={own.data.total} onChange={setOwnOffset} />}
        </Card>
      </div>
    </div>
  );
}
