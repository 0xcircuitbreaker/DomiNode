import { useState } from "react";
import { useApi } from "../../hooks/useApi";
import { killSwitchApi, type KillSwitch, type KillSwitchKey } from "../../api/admin";
import { fmtDate, shortId } from "../../lib/format";
import { Badge, Card, ConfirmDialog, DataTable, ErrorBox, Field, Loading, Mono, Notice, PageHeader } from "../components/ui";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SWITCH_LABELS: Record<KillSwitchKey, { label: string; group: string; effect: string }> = {
  relay: { label: "All new relay sessions", group: "Relay", effect: "RELAY_PAUSED" },
  relay_residential: { label: "Residential exits", group: "Relay", effect: "EXIT_CLASS_PAUSED" },
  relay_mobile: { label: "Mobile exits", group: "Relay", effect: "EXIT_CLASS_PAUSED" },
  relay_dc: { label: "Datacenter exits", group: "Relay", effect: "EXIT_CLASS_PAUSED" },
  relay_masked: { label: "Masked exits", group: "Relay", effect: "EXIT_CLASS_PAUSED" },
  signups: { label: "New signups", group: "Accounts", effect: "SIGNUPS_PAUSED" },
  api_keys: { label: "New API keys", group: "Accounts", effect: "API_KEYS_PAUSED" },
  payouts: { label: "Payouts and withdrawals", group: "Money", effect: "PAYOUTS_PAUSED" },
  rail_x402: { label: "x402 rail", group: "Payment rails", effect: "PAYMENT_RAIL_PAUSED" },
  rail_mpp: { label: "MPP rail", group: "Payment rails", effect: "PAYMENT_RAIL_PAUSED" },
  rail_tempo: { label: "Tempo top-ups", group: "Payment rails", effect: "PAYMENT_RAIL_PAUSED" },
  rail_nowpayments: { label: "NOWPayments top-ups", group: "Payment rails", effect: "PAYMENT_RAIL_PAUSED" },
};

export default function KillSwitchesPage() {
  const s = useApi(() => killSwitchApi.state(), []);
  const [target, setTarget] = useState<KillSwitch | null>(null);
  const [undrain, setUndrain] = useState<string | null>(null);
  const [drainId, setDrainId] = useState("");
  const [drainOpen, setDrainOpen] = useState(false);
  const [drainErr, setDrainErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const engaged = s.data?.switches.filter((x) => x.engaged) ?? [];
  const secs = Math.round((s.data?.pollIntervalMs ?? 5000) / 1000);

  return (
    <div className="space-y-5">
      <PageHeader title="Kill switches" subtitle={`Pause new work across the network. Gateways and API instances apply changes within ~${secs} s and refuse everything if they cannot read this state.`} />
      {msg && <Notice tone="good">{msg}</Notice>}
      {engaged.length > 0 && <Notice tone="warn">{engaged.length} switch{engaged.length === 1 ? "" : "es"} engaged: {engaged.map((x) => SWITCH_LABELS[x.key]?.label ?? x.key).join(", ")}</Notice>}
      <ErrorBox error={s.error} onRetry={s.refetch} />
      <Card title="Switches" bodyClassName="pt-0">
        {s.loading && !s.data ? <Loading /> : (
          <DataTable caption="Kill switches" rowKey={(x) => x.key} rows={s.data?.switches ?? []}
            columns={[
              { key: "g", header: "Area", render: (x) => SWITCH_LABELS[x.key]?.group ?? "" },
              { key: "l", header: "Switch", render: (x) => SWITCH_LABELS[x.key]?.label ?? x.key },
              { key: "s", header: "State", render: (x) => (x.engaged ? <Badge tone="bad">paused</Badge> : <Badge tone="good">running</Badge>) },
              { key: "c", header: "Agent error", render: (x) => <Mono>{SWITCH_LABELS[x.key]?.effect ?? ""}</Mono> },
              { key: "r", header: "Reason", render: (x) => x.reason ?? "—" },
              { key: "u", header: "Updated", render: (x) => (x.updatedBy ? fmtDate(x.updatedAt) : "—") },
              { key: "x", header: <span className="sr-only">Actions</span>, render: (x) => (
                <button type="button" className={x.engaged ? "btn-secondary !py-1 text-xs" : "btn-danger !py-1 text-xs"}
                  aria-label={`${x.engaged ? "Resume" : "Pause"} ${SWITCH_LABELS[x.key]?.label ?? x.key}`} onClick={() => setTarget(x)}>
                  {x.engaged ? "Resume" : "Pause"}
                </button>
              ) },
            ]} />
        )}
      </Card>
      <Card title="Drained nodes" actions={<button type="button" className="btn-secondary !py-1 text-xs" onClick={() => { setDrainErr(null); setDrainOpen(true); }}>Drain a node</button>} bodyClassName="pt-0">
        <DataTable caption="Drained nodes" rowKey={(d) => d.nodeId} rows={s.data?.drainedNodes.items ?? []} empty="No drained nodes"
          columns={[
            { key: "n", header: "Node", render: (d) => <Mono title={d.nodeId}>{shortId(d.nodeId)}</Mono> },
            { key: "c", header: "Class", render: (d) => d.ipClass ?? "—" },
            { key: "s", header: "Status", render: (d) => (d.status ? <Badge>{d.status}</Badge> : "—") },
            { key: "r", header: "Reason", render: (d) => d.reason },
            { key: "t", header: "Since", render: (d) => fmtDate(d.createdAt) },
            { key: "x", header: <span className="sr-only">Actions</span>, render: (d) => (
              <button type="button" className="btn-secondary !py-1 text-xs" onClick={() => setUndrain(d.nodeId)}>Undrain</button>
            ) },
          ]} />
      </Card>
      <ConfirmDialog open={target !== null} reason="required" danger={!target?.engaged}
        title={`${target?.engaged ? "Resume" : "Pause"}: ${target ? SWITCH_LABELS[target.key]?.label ?? target.key : ""}`}
        confirmLabel={target?.engaged ? "Resume" : "Pause"}
        description={target?.engaged ? "New work of this kind is accepted again once instances re-poll." : "New work of this kind is refused with a 503. Work already in flight finishes. The change is audited."}
        onClose={() => setTarget(null)}
        onConfirm={async (reason) => {
          const r = await killSwitchApi.set(target!.key, !target!.engaged, reason);
          setTarget(null); setMsg(`${SWITCH_LABELS[r.key]?.label ?? r.key} ${r.engaged ? "paused" : "resumed"}.`); s.refetch();
        }} />
      <ConfirmDialog open={drainOpen} reason="required" danger title="Drain a node" confirmLabel="Drain"
        description="The node gets no new sessions; open streams finish. It stays connected."
        onClose={() => setDrainOpen(false)}
        onConfirm={async (reason) => {
          const id = drainId.trim();
          if (!UUID.test(id)) { setDrainErr("Enter a node id (UUID)"); throw new Error("Enter a node id (UUID)"); }
          await killSwitchApi.drain(id, reason);
          setDrainOpen(false); setDrainId(""); setMsg(`Node ${shortId(id)} drained.`); s.refetch();
        }}>
        <Field label="Node id" className="mt-3">{(id) => (
          <>
            <input id={id} className="input w-full" value={drainId} onChange={(e) => setDrainId(e.target.value)} />
            {drainErr && <p role="alert" className="mt-1 text-xs text-red-400">{drainErr}</p>}
          </>
        )}</Field>
      </ConfirmDialog>
      <ConfirmDialog open={undrain !== null} reason="required" title={`Undrain node ${shortId(undrain)}`} confirmLabel="Undrain"
        onClose={() => setUndrain(null)}
        onConfirm={async (reason) => {
          await killSwitchApi.undrain(undrain!, reason);
          setMsg(`Node ${shortId(undrain)} undrained.`); setUndrain(null); s.refetch();
        }} />
    </div>
  );
}
