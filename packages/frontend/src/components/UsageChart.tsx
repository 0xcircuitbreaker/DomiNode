import { useMemo } from "react";

interface DayData {
  date: string;
  totalGB: number;
  totalCostUsd: number;
  requestCount: number;
}

interface UsageChartProps {
  days: DayData[];
  metric?: "bandwidth" | "cost" | "requests";
}

export default function UsageChart({ days, metric = "bandwidth" }: UsageChartProps) {
  const { bars, maxValue, label, format } = useMemo(() => {
    let getValue: (d: DayData) => number;
    let lbl: string;
    let fmt: (v: number) => string;

    switch (metric) {
      case "cost":
        getValue = (d) => d.totalCostUsd;
        lbl = "Daily Spend ($)";
        fmt = (v) => `$${v.toFixed(2)}`;
        break;
      case "requests":
        getValue = (d) => d.requestCount;
        lbl = "Daily Requests";
        fmt = (v) => v.toLocaleString();
        break;
      default:
        getValue = (d) => d.totalGB;
        lbl = "Daily Bandwidth (GB)";
        fmt = (v) => `${v.toFixed(3)} GB`;
    }

    const values = days.map(getValue);
    const max = Math.max(...values, 0.001); // avoid division by zero

    return {
      bars: days.map((d, i) => ({
        date: d.date,
        value: values[i],
        height: (values[i] / max) * 100,
      })),
      maxValue: max,
      label: lbl,
      format: fmt,
    };
  }, [days, metric]);

  if (days.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500 text-sm">
        No usage data for this period.
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm text-gray-400 mb-3">{label}</p>
      <div className="flex items-end gap-px h-32">
        {bars.map((bar) => (
          <div
            key={bar.date}
            className="flex-1 group relative"
            style={{ minWidth: "4px" }}
          >
            <div
              className="bg-indigo-500 hover:bg-indigo-400 rounded-t transition-colors w-full"
              style={{ height: `${Math.max(bar.height, 1)}%` }}
            />
            {/* Tooltip */}
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-10">
              <div className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs whitespace-nowrap">
                <p className="text-gray-300">{formatDate(bar.date)}</p>
                <p className="text-indigo-400 font-medium">{format(bar.value)}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
      {/* X-axis labels (show first, middle, last) */}
      <div className="flex justify-between mt-1 text-xs text-gray-500">
        <span>{bars.length > 0 ? formatDate(bars[0].date) : ""}</span>
        {bars.length > 2 && (
          <span>{formatDate(bars[Math.floor(bars.length / 2)].date)}</span>
        )}
        <span>{bars.length > 1 ? formatDate(bars[bars.length - 1].date) : ""}</span>
      </div>
      {/* Y-axis max label */}
      <div className="text-right text-xs text-gray-500 -mt-1">
        max: {format(maxValue)}
      </div>
    </div>
  );
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
