import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useTheme } from "../../context/ThemeContext";

/**
 * Categorical palette (fixed order, never cycled) stepped separately for the
 * light and dark chart surfaces. Validated with the dataviz palette checker.
 */
const SERIES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#2f9a2f"],
};

export function useChartTheme() {
  const { theme } = useTheme();
  const dark = theme === "dark";
  return {
    series: dark ? SERIES.dark : SERIES.light,
    grid: dark ? "#1e293b" : "#e2e8f0",
    axis: dark ? "#94a3b8" : "#64748b",
    tooltipBg: dark ? "#0f172a" : "#ffffff",
    tooltipBorder: dark ? "#334155" : "#cbd5e1",
    text: dark ? "#e2e8f0" : "#0f172a",
    surface: dark ? "#0f172a" : "#ffffff",
  };
}

export interface SeriesDef { key: string; label: string; color?: number }

function tooltipProps(t: ReturnType<typeof useChartTheme>, fmt: (v: number) => string, labelFmt?: (l: string) => string) {
  return {
    contentStyle: { background: t.tooltipBg, border: `1px solid ${t.tooltipBorder}`, borderRadius: 8, fontSize: 12, color: t.text },
    labelStyle: { color: t.text, fontWeight: 600 },
    itemStyle: { color: t.text },
    formatter: (v: unknown) => fmt(Number(v)),
    labelFormatter: labelFmt ? (l: unknown) => labelFmt(String(l)) : undefined,
    cursor: { stroke: t.axis, strokeWidth: 1, fill: t.grid, fillOpacity: 0.4 },
  };
}

/** Tiny trend line for KPI tiles; one series, so no legend. */
export function Sparkline({ data, label, format, color = 0 }: {
  data: Array<{ t: string; v: number }>; label: string; format: (v: number) => string; color?: number;
}) {
  const t = useChartTheme();
  if (data.length === 0) return <div className="mt-2 h-12 text-xs text-slate-400">No data</div>;
  return (
    <div className="mt-2 h-12" role="img" aria-label={`${label} trend`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 2, bottom: 2, left: 2 }}>
          <Tooltip {...tooltipProps(t, format, (l) => l.slice(0, 16).replace("T", " "))} />
          <XAxis dataKey="t" hide />
          <YAxis hide domain={[0, "auto"]} />
          <Line type="monotone" dataKey="v" name={label} stroke={t.series[color]} strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Time series with a single y-axis. `stacked` stacks bars/areas (parts of a whole). */
export function TimeChart({ data, series, format, axisFormat, xFormat, kind = "line", stacked = false, height = 260, label }: {
  data: Array<Record<string, number | string>>; series: SeriesDef[]; format: (v: number) => string;
  axisFormat?: (v: number) => string; xFormat: (t: string) => string; kind?: "line" | "area" | "bar";
  stacked?: boolean; height?: number; label: string;
}) {
  const t = useChartTheme();
  const common = { data, margin: { top: 8, right: 8, bottom: 0, left: 0 } };
  const axes = [
    <CartesianGrid key="g" stroke={t.grid} vertical={false} />,
    <XAxis key="x" dataKey="t" tickFormatter={xFormat} stroke={t.axis} tick={{ fontSize: 11, fill: t.axis }} tickLine={false} axisLine={{ stroke: t.grid }} minTickGap={24} />,
    <YAxis key="y" tickFormatter={axisFormat ?? format} stroke={t.axis} tick={{ fontSize: 11, fill: t.axis }} tickLine={false} axisLine={false} width={64} />,
    <Tooltip key="tt" {...tooltipProps(t, format, xFormat)} />,
    ...(series.length > 1 ? [<Legend key="l" iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: t.axis }} />] : []),
  ];
  const color = (s: SeriesDef, i: number) => t.series[(s.color ?? i) % t.series.length];
  let chart;
  if (kind === "bar") {
    chart = (
      <BarChart {...common}>
        {axes}
        {series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} fill={color(s, i)} stackId={stacked ? "a" : undefined}
            stroke={t.surface} strokeWidth={stacked ? 1 : 0} radius={stacked && i < series.length - 1 ? 0 : [3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false} />
        ))}
      </BarChart>
    );
  } else if (kind === "area") {
    chart = (
      <AreaChart {...common}>
        {axes}
        {series.map((s, i) => (
          <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={color(s, i)} fill={color(s, i)} fillOpacity={0.18}
            strokeWidth={2} stackId={stacked ? "a" : undefined} isAnimationActive={false} />
        ))}
      </AreaChart>
    );
  } else {
    chart = (
      <LineChart {...common}>
        {axes}
        {series.map((s, i) => (
          <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={color(s, i)} strokeWidth={2}
            dot={data.length < 3 ? { r: 4 } : false} activeDot={{ r: 4, stroke: t.surface, strokeWidth: 2 }} isAnimationActive={false} />
        ))}
      </LineChart>
    );
  }
  if (data.length === 0) {
    return <div style={{ height }} className="flex items-center justify-center text-sm text-slate-400">No data in this range</div>;
  }
  return (
    <div style={{ height }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">{chart}</ResponsiveContainer>
    </div>
  );
}

/** Horizontal bar chart for ranked categories (countries, ASNs). One series. */
export function RankBars({ data, format, label, color = 0 }: {
  data: Array<{ name: string; value: number }>; format: (v: number) => string; label: string; color?: number;
}) {
  const t = useChartTheme();
  if (data.length === 0) return <div className="py-8 text-center text-sm text-slate-400">No data</div>;
  const height = Math.max(120, data.length * 26 + 30);
  return (
    <div style={{ height }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid stroke={t.grid} horizontal={false} />
          <XAxis type="number" tickFormatter={format} stroke={t.axis} tick={{ fontSize: 11, fill: t.axis }} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey="name" width={56} stroke={t.axis} tick={{ fontSize: 11, fill: t.axis }} tickLine={false} axisLine={{ stroke: t.grid }} />
          <Tooltip {...tooltipProps(t, format)} />
          <Bar dataKey="value" name={label} fill={t.series[color]} radius={[0, 3, 3, 0]} maxBarSize={18} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
