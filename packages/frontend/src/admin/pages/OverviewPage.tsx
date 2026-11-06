import { Link } from "react-router-dom";
import { useApi } from "../../hooks/useApi";
import { adminApi } from "../../api/admin";
import { fmtGb, fmtInt, fmtMoney, fmtUsdNumber, musdToUsd, fmtDate } from "../../lib/format";
import { Card, ErrorBox, Kpi, Loading, PageHeader } from "../components/ui";
import { Sparkline } from "../components/charts";

const WINDOWS = ["24h", "7d", "30d"] as const;

export default function OverviewPage() {
  const ov = useApi(() => adminApi.overview());
  const rev = useApi(() => adminApi.revenue({ bucket: "day" }));

  if (ov.loading && !ov.data) return <Loading />;
  if (!ov.data) return <ErrorBox error={ov.error ?? "Failed to load"} onRetry={ov.refetch} />;
  const o = ov.data;
  const series = rev.data?.series ?? [];
  const grossSpark = series.map((p) => ({ t: p.t, v: musdToUsd(p.gross.musd) }));
  const gbSpark = series.map((p) => ({ t: p.t, v: Number(p.gb) }));
  const p = o.payouts;

  return (
    <div>
      <PageHeader title="Overview" subtitle={`Generated ${fmtDate(o.generatedAt)}`}
        actions={<button type="button" className="btn-secondary" onClick={() => { ov.refetch(); rev.refetch(); }}>Refresh</button>} />
      <ErrorBox error={ov.error} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Nodes online" value={fmtInt(o.nodes.online)} sub={`${fmtInt(o.nodes.total)} total`} />
        <Kpi label="Unique /24s online" value={fmtInt(o.nodes.uniquePrefixesOnline)} sub="IPv6 counted per /48" />
        <Kpi label="ASNs online" value={fmtInt(o.nodes.uniqueAsnsOnline)} />
        <Kpi label="Active agents 24h" value={fmtInt(o.agents.requestersActive24h)}
          sub={`${fmtInt(o.agents.requestersActive7d)} 7d · ${fmtInt(o.agents.requestersActive30d)} 30d`} />
        <Kpi label="Node owners" value={fmtInt(o.agents.nodeOwners)} sub={`${fmtInt(o.agents.nodeOwnersWithActiveNode)} with active node`} />
        <Kpi label="Quarantined" value={<Link className="hover:underline" to="/admin/nodes?status=quarantined">{fmtInt(o.nodes.quarantined)}</Link>}
          tone={o.nodes.quarantined > 0 ? "warn" : undefined} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Kpi label="Gross revenue 30d" value={fmtMoney(o.traffic["30d"].gross)} sub="Daily gross, last 30 days">
          <Sparkline data={grossSpark} label="Gross revenue" format={fmtUsdNumber} />
        </Kpi>
        <Kpi label="Traffic 30d" value={fmtGb(o.traffic["30d"].gb)} sub={`${fmtInt(o.traffic["30d"].charges)} charges · daily GB`}>
          <Sparkline data={gbSpark} label="Traffic" format={(v) => fmtGb(v)} color={2} />
        </Kpi>
      </div>

      <Card title="Revenue & traffic by window" className="mt-4">
        <div className="relative -mx-4 overflow-x-auto">
          <table className="w-full min-w-max text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                <th scope="col" className="px-4 py-2 text-left font-medium">Window</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Gross</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Platform</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Node share</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Traffic</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Charges</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {[...WINDOWS, "all" as const].map((w) => {
                const t = o.traffic[w];
                return (
                  <tr key={w} className="border-b border-slate-100 last:border-0 dark:border-slate-800/70">
                    <th scope="row" className="px-4 py-2 text-left font-medium">{w}</th>
                    <td className="px-4 py-2 text-right">{fmtMoney(t.gross)}</td>
                    <td className="px-4 py-2 text-right">{fmtMoney(t.platform)}</td>
                    <td className="px-4 py-2 text-right">{fmtMoney(t.node)}</td>
                    <td className="px-4 py-2 text-right">{fmtGb(t.gb)}</td>
                    <td className="px-4 py-2 text-right">{fmtInt(t.charges)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <h2 className="mb-2 mt-6 text-sm font-semibold text-slate-700 dark:text-slate-300">Credits, payouts & disputes</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Pending credits" value={fmtMoney(o.credits.pending)} sub="Not yet matured" />
        <Kpi label="Available credits" value={fmtMoney(o.credits.available)} sub={`${fmtInt(o.credits.accounts)} accounts`} />
        <Kpi label="Frozen accounts" value={fmtInt(o.credits.frozenAccounts)} sub={fmtMoney(o.credits.frozenBalance)}
          tone={o.credits.frozenAccounts > 0 ? "warn" : undefined} />
        <Kpi label="Payout backlog" value={fmtMoney(p.pending.amount)}
          sub={`${fmtInt(p.pending.count)} pending · ${fmtInt(p.submitted.count)} submitted`} />
        <Kpi label="Held payouts" value={fmtInt(p.heldTax.count + p.heldFrozen.count)}
          sub={`${fmtInt(p.heldTax.count)} tax · ${fmtInt(p.heldFrozen.count)} frozen`} />
        <Kpi label="Open disputes" value={<Link className="hover:underline" to="/admin/disputes">{fmtInt(o.disputes.open)}</Link>}
          sub={`${fmtInt(o.disputes.nodesWithOpen)} nodes`} tone={o.disputes.open > 0 ? "warn" : undefined} />
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi label="Confirmed payouts 30d" value={fmtMoney(p.confirmed30d.amount)} sub={`${fmtInt(p.confirmed30d.count)} payouts`} />
        <Kpi label="Failed payouts 30d" value={fmtInt(p.failed30d.count)} sub={fmtMoney(p.failed30d.amount)} tone={p.failed30d.count > 0 ? "bad" : undefined} />
        <Kpi label="Reversed payouts 30d" value={fmtInt(p.reversed30d.count)} sub={fmtMoney(p.reversed30d.amount)} />
      </div>
    </div>
  );
}
