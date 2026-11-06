import type { HttpClient } from "../http.js";
import { invalidArg } from "../errors.js";
import { seg, validateUuid } from "../validation.js";

/** Active proxy session. Deliberately has NO proxy/upstream/node IP field. */
export interface ActiveSession {
  id: string;
  startedAt: string;
  status: string;
}

export const REPORT_REASONS = ["blocked", "captcha", "rate_limited", "slow", "bad_content", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface ReportResult {
  reportId: string;
  reportsToday: number;
  limitPerDay: number;
}

export class SessionsResource {
  constructor(private http: HttpClient) {}

  /** GET /api/sessions/active */
  async getActive(): Promise<{ sessions: ActiveSession[] }> {
    const r = await this.http.get<{ sessions: Array<Record<string, unknown>> }>("/api/sessions/active");
    // Whitelist fields: never surface an IP even if a server regression sends one.
    return {
      sessions: (r.sessions ?? []).map((s) => ({ id: String(s["id"]), startedAt: String(s["startedAt"]), status: String(s["status"]) })),
    };
  }

  /**
   * POST /v1/sessions/:id/report — report a burned exit (feeds node reputation).
   * Own relay sessions from the last 7 days; one report per session; 5 per node per UTC day.
   */
  async report(sessionId: string, reason: ReportReason): Promise<ReportResult> {
    validateUuid(sessionId, "sessionId");
    if (!(REPORT_REASONS as readonly string[]).includes(reason)) throw invalidArg(`reason must be one of ${REPORT_REASONS.join(", ")}`);
    return this.http.post(`/v1/sessions/${seg(sessionId)}/report`, { reason }, "agent");
  }
}
