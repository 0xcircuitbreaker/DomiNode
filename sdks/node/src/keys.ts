import type { HttpClient } from "./http.js";
import type { ApiKey } from "./types.js";

export interface CreateKeyResponse {
  key: string;
  id: string;
  prefix: string;
  label: string;
  created_at: string;
}

export interface ListKeysResponse {
  keys: Array<{
    id: string;
    prefix: string;
    label: string;
    created_at: string;
    revoked_at: string | null;
  }>;
}

export class KeysResource {
  constructor(private http: HttpClient) {}

  /** Create a new API key. The raw key is returned only once. */
  async create(label?: string): Promise<CreateKeyResponse> {
    return this.http.post("/api/keys", { label: label ?? "Default" });
  }

  /** List all API keys for the authenticated user. */
  async list(): Promise<ListKeysResponse> {
    return this.http.get("/api/keys");
  }

  /** Revoke an API key by its ID. */
  async revoke(id: string): Promise<void> {
    await this.http.delete(`/api/keys/${encodeURIComponent(id)}`);
  }
}
