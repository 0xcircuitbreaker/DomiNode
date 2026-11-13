import { describe, it, expect, vi } from "vitest";
import { runOnce } from "./user-status.js";

describe("user-status-sweep", () => {
  it("terminates sessions of suspended and deleted users only", async () => {
    const terminate = vi.fn(async (id: string) => (id === "b" ? 2 : 1));
    const r = await runOnce({
      liveUserIds: () => ["a", "b", "c", "a", "d"],
      fetchStatuses: async () => new Map([["a", "active"], ["b", "suspended"], ["d", "active"]]),
      terminate,
    });
    expect(terminate.mock.calls.map((c) => c[0]).sort()).toEqual(["b", "c"]);
    expect(r).toEqual({ checked: 4, users: 2, sessions: 3 });
  });

  it("does not query without live sessions", async () => {
    const fetchStatuses = vi.fn();
    const r = await runOnce({ liveUserIds: () => [], fetchStatuses, terminate: vi.fn() });
    expect(r.checked).toBe(0);
    expect(fetchStatuses).not.toHaveBeenCalled();
  });
});
