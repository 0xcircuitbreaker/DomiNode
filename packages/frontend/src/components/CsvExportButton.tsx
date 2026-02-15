import { useState } from "react";

interface CsvExportButtonProps {
  since: string;
  until: string;
}

export default function CsvExportButton({ since, until }: CsvExportButtonProps) {
  const [downloading, setDownloading] = useState(false);

  async function handleExport() {
    setDownloading(true);
    try {
      const url = `/api/usage/export?since=${since}T00:00:00Z&until=${until}T23:59:59Z&format=csv`;

      const res = await fetch(url, {
        credentials: "include",
      });

      if (!res.ok) {
        throw new Error(`Export failed: ${res.status}`);
      }

      const blob = await res.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;

      // Extract filename from Content-Disposition or use fallback
      const disposition = res.headers.get("Content-Disposition");
      const filenameMatch = disposition?.match(/filename="(.+)"/);
      a.download = filenameMatch?.[1] ?? `dominusnode-usage-${since}-to-${until}.csv`;

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
