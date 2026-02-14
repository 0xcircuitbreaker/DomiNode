import { type ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: string;
  render: (item: T) => ReactNode;
  primary?: boolean;
  hideOnMobile?: boolean;
  align?: "left" | "right";
}

interface ResponsiveTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (item: T) => string;
  emptyMessage?: string;
}

export default function ResponsiveTable<T>({
  columns,
  data,
  keyExtractor,
  emptyMessage = "No data.",
}: ResponsiveTableProps<T>) {
  const primaryCol = columns.find((c) => c.primary);
  const rightCol = columns.find((c) => c.align === "right");
  const detailCols = columns.filter(
    (c) => !c.primary && c.align !== "right" && !c.hideOnMobile,
  );

  return (
    <>
      {/* Desktop table (>=768px) */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-400">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`${col.align === "right" ? "text-right" : "text-left"} px-4 py-3 font-medium`}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-8 text-center text-gray-500"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              data.map((item) => (
                <tr
                  key={keyExtractor(item)}
                  className="border-b border-gray-800/50"
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={`px-4 py-3 ${col.align === "right" ? "text-right" : ""}`}
                    >
                      {col.render(item)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile card layout (<768px) */}
      <div className="md:hidden space-y-2">
        {data.length === 0 ? (
          <p className="px-4 py-8 text-center text-gray-500 text-sm">
            {emptyMessage}
          </p>
        ) : (
          data.map((item) => (
            <div
              key={keyExtractor(item)}
              className="border border-gray-800/50 rounded-lg p-3 space-y-1.5"
            >
              {/* Card heading row: primary + right-aligned */}
              {(primaryCol || rightCol) && (
                <div className="flex items-center justify-between gap-2">
                  {primaryCol && (
                    <div className="font-medium text-sm min-w-0 truncate">
                      {primaryCol.render(item)}
                    </div>
                  )}
                  {rightCol && (
                    <div className="flex-shrink-0 text-sm">
                      {rightCol.render(item)}
                    </div>
                  )}
                </div>
              )}
              {/* Detail rows: label:value pairs */}
              {detailCols.map((col) => (
                <div
                  key={col.key}
                  className="flex items-center justify-between text-xs"
                >
                  <span className="text-gray-500">{col.header}</span>
                  <span className="text-gray-300">{col.render(item)}</span>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </>
  );
}
