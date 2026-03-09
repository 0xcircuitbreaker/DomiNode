import { useState } from "react";

interface PaginationProps {
  /** Current page (1-based for page-based, 0-based for offset-based) */
  page: number;
  totalPages: number;
  /** Total item count for display */
  totalItems?: number;
  /** Label for items (e.g. "users", "records") */
  itemLabel?: string;
  /** Whether page is 0-based (offset mode) or 1-based (default) */
  zeroBased?: boolean;
  /** How many page numbers to show around current page */
  siblingCount?: number;
  onPageChange: (page: number) => void;
}

/**
 * Reusable pagination with page numbers, prev/next, and jump-to-page input.
 * Supports both 1-based (AdminPage) and 0-based (UsagePage) indexing.
 */
export default function Pagination({
  page,
  totalPages,
  totalItems,
  itemLabel,
  zeroBased = false,
  siblingCount = 2,
  onPageChange,
}: PaginationProps) {
  const [jumpInput, setJumpInput] = useState("");

  if (totalPages <= 1) return null;

  // Normalize to 1-based for display
  const displayPage = zeroBased ? page + 1 : page;
  const firstPage = zeroBased ? 0 : 1;
  const lastPage = zeroBased ? totalPages - 1 : totalPages;

  // Calculate visible page range
  const startPage = Math.max(firstPage, (zeroBased ? page : page) - siblingCount);
  const endPage = Math.min(lastPage, (zeroBased ? page : page) + siblingCount);

  const pageNumbers: number[] = [];
  for (let i = startPage; i <= endPage; i++) {
    pageNumbers.push(i);
  }

  function handleJump(e: React.FormEvent) {
    e.preventDefault();
    const target = parseInt(jumpInput, 10);
    if (isNaN(target) || target < 1 || target > totalPages) return;
    const targetPage = zeroBased ? target - 1 : target;
    onPageChange(targetPage);
    setJumpInput("");
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-gray-800">
      <p className="text-xs text-gray-500">
        Page {displayPage} of {totalPages}{totalItems !== undefined ? ` (${totalItems} ${itemLabel ?? "items"})` : ""}
      </p>
      <div className="flex items-center gap-1">
        {/* Previous */}
        <button
          onClick={() => onPageChange(Math.max(firstPage, (zeroBased ? page : page) - 1))}
          disabled={page === firstPage}
          className="px-3 py-1.5 rounded-lg text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Prev
        </button>

        {/* First page + ellipsis */}
        {startPage > firstPage && (
          <>
            <button
              onClick={() => onPageChange(firstPage)}
              className="w-8 h-8 rounded-lg text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 transition-colors"
            >
              {zeroBased ? 1 : 1}
            </button>
            {startPage > firstPage + 1 && (
              <span className="text-xs text-gray-600 px-1">...</span>
            )}
          </>
        )}

        {/* Page numbers */}
        {pageNumbers.map((p) => {
          const isActive = p === page;
          const displayNum = zeroBased ? p + 1 : p;
          return (
            <button
              key={p}
              onClick={() => onPageChange(p)}
              className={`w-8 h-8 rounded-lg text-xs transition-colors ${
                isActive
                  ? "bg-indigo-600 text-white font-semibold"
                  : "bg-gray-800 text-gray-400 hover:bg-gray-700"
              }`}
            >
              {displayNum}
            </button>
          );
        })}

        {/* Last page + ellipsis */}
        {endPage < lastPage && (
          <>
            {endPage < lastPage - 1 && (
              <span className="text-xs text-gray-600 px-1">...</span>
            )}
            <button
              onClick={() => onPageChange(lastPage)}
              className="w-8 h-8 rounded-lg text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 transition-colors"
            >
              {totalPages}
            </button>
          </>
        )}

        {/* Next */}
        <button
          onClick={() => onPageChange(Math.min(lastPage, (zeroBased ? page : page) + 1))}
          disabled={page >= lastPage}
          className="px-3 py-1.5 rounded-lg text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Next
        </button>

        {/* Jump to page */}
        {totalPages > 5 && (
          <form onSubmit={handleJump} className="flex items-center gap-1 ml-2">
            <input
              type="text"
              inputMode="numeric"
              value={jumpInput}
              onChange={(e) => setJumpInput(e.target.value.replace(/\D/g, ""))}
              placeholder="#"
              className="w-12 h-8 rounded-lg text-xs text-center bg-gray-800 border border-gray-700 text-gray-300 focus:outline-none focus:border-indigo-500"
              maxLength={5}
            />
            <button
              type="submit"
              className="px-2 h-8 rounded-lg text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
            >
              Go
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
