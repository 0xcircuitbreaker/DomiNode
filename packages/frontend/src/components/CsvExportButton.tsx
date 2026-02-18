import { useState } from "react";

interface CsvExportButtonProps {
  since: string;
  until: string;
}

export default function CsvExportButton({ since, until }: CsvExportButtonProps) {
  const [downloading, setDownloading] = useState(false);

  async function handleExport() {
    // R26 H-2: Validate date format before constructing URL to prevent parameter injection
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (!DATE_RE.test(since) || !DATE_RE.test(until)) return;

    setDownloading(true);
    try {
      const params = new URLSearchParams({
        since: `${since}T00:00:00Z`,
        until: `${until}T23:59:59Z`,
        format: "csv",
      });
      const url = `/api/usage/export?${params.toString()}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60_000); // 60s export timeout
      let res: Response;
      try {
        res = await fetch(url, {
          credentials: "include",
          redirect: "error", // R19 C-2: Prevent credential leakage via redirect
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        throw new Error(`Export failed: ${res.status}`);
      }

      // R24 H-4: Pre-flight Content-Length check before buffering (prevents OOM)
      const MAX_EXPORT_BYTES = 50 * 1024 * 1024; // 50MB
      const exportContentLength = parseInt(res.headers.get("content-length") ?? "0", 10);
      if (exportContentLength > MAX_EXPORT_BYTES) {
        throw new Error("Export too large — please narrow the date range");
      }
      const blob = await res.blob();
      // R23 H-4: Defense-in-depth size check after buffering
      if (blob.size > MAX_EXPORT_BYTES) {
        throw new Error("Export too large — please narrow the date range");
      }
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;

      // Extract filename from Content-Disposition or use fallback
      // R22 C-2: Sanitize filename to prevent path traversal / deceptive extensions
      const disposition = res.headers.get("Content-Disposition");
      const filenameMatch = disposition?.match(/filename="(.+)"/);
      let filename = filenameMatch?.[1] ?? `dominusnode-usage-${since}-to-${until}.csv`;
      filename = filename.replace(/[/\\]/g, "_").replace(/[^\w.\-]/g, "_");
      if (!filename.endsWith(".csv")) {
        filename = `dominusnode-usage-${since}-to-${until}.csv`;
      }
      a.download = filename;

      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      console.error("CSV export failed:", err);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <button
      onClick={handleExport}
      disabled={downloading}
      className="bg-gray-800 hover:bg-gray-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
    >
      <svg
        className="w-4 h-4"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </svg>
      {downloading ? "Exporting..." : "Export CSV"}
    </button>
  );
}
