import type { HttpClient } from "../http.js";
import { Secret } from "../secret.js";
import { seg, validateNonEmpty } from "../validation.js";

export interface ApiKeyInfo {
  id: string;
  prefix: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
}

export interface CreatedApiKey {
  id: string;
  prefix: string;
  label: string;
  created_at: string;
  /** The raw dn_live_ key, returned ONCE. Redacted when printed; call key.reveal(). */
  key: Secret;
}

export class KeysResource {
  constructor(private http: HttpClient) {}

  /** POST /api/keys — create an API key (requires a verified account). */
  async create(label = "Default"): Promise<CreatedApiKey> {
    validateNonEmpty(label, "label", 100);
    const r = await this.http.post<Omit<CreatedApiKey, "key"> & { key: string }>("/api/keys", { label });
    return { ...r, key: new Secret(r.key) };
  }

  /** GET /api/keys */
  async list(): Promise<{ keys: ApiKeyInfo[] }> {
    return this.http.get("/api/keys");
  }

  /** DELETE /api/keys/:id */
  async revoke(id: string): Promise<void> {
    await this.http.delete(`/api/keys/${seg(validateNonEmpty(id, "id"))}`);
  }
}
