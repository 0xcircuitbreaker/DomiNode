import type { HttpClient } from "./http.js";
import type { SlotsInfo, WaitlistJoinResult, WaitlistCount } from "./types.js";

export class SlotsResource {
  constructor(private http: HttpClient) {}

  async getSlots(): Promise<SlotsInfo> {
    return this.http.get("/api/slots", false);
  }

  async joinWaitlist(email: string): Promise<WaitlistJoinResult> {
    return this.http.post("/api/waitlist/join", { email }, false);
  }

  async getWaitlistCount(): Promise<WaitlistCount> {
    return this.http.get("/api/waitlist/count", false);
  }
}
