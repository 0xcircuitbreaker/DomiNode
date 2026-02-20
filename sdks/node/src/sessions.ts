import type { HttpClient } from "./http.js";

export interface ActiveSessionEntry {
  id: string;
  startedAt: string;
  status: string;
}

export interface ActiveSessionsResponse {
  sessions: ActiveSessionEntry[];
}

export class SessionsResource {
  constructor(private http: HttpClient) {}

  /** Get all active proxy sessions for the authenticated user. */
  async getActive(): Promise<ActiveSessionsResponse> {
    return this.http.get("/api/sessions/active");
  }
}
