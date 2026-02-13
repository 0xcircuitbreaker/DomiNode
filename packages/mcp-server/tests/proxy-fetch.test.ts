import { describe, it, expect } from "vitest";
import { validateUrl } from "../src/proxy-fetch.js";

describe("proxy-fetch", () => {
  describe("validateUrl", () => {
    it("accepts http URLs", () => {
      const parsed = validateUrl("http://example.com/path?q=1");
      expect(parsed.protocol).toBe("http:");
      expect(parsed.hostname).toBe("example.com");
    });

    it("accepts https URLs", () => {
      const parsed = validateUrl("https://example.com:8443/path");
      expect(parsed.protocol).toBe("https:");
      expect(parsed.port).toBe("8443");
    });

    it("rejects invalid URLs", () => {
      expect(() => validateUrl("not-a-url")).toThrow("Invalid URL");
    });

    it("rejects file: protocol", () => {
      expect(() => validateUrl("file:///etc/passwd")).toThrow("Only http: and https:");
    });

    it("rejects ftp: protocol", () => {
      expect(() => validateUrl("ftp://ftp.example.com")).toThrow("Only http: and https:");
    });

    it("rejects data: protocol", () => {
      expect(() => validateUrl("data:text/html,<h1>test</h1>")).toThrow("Only http: and https:");
    });

    // SSRF protection tests
    it("blocks localhost", () => {
      expect(() => validateUrl("http://localhost/admin")).toThrow("localhost/loopback");
    });

    it("blocks 127.0.0.1", () => {
      expect(() => validateUrl("http://127.0.0.1/admin")).toThrow("private/internal");
    });

    it("blocks 10.x.x.x private range", () => {
      expect(() => validateUrl("http://10.0.0.1/internal")).toThrow("private/internal");
    });

    it("blocks 172.16.x.x private range", () => {
      expect(() => validateUrl("http://172.16.0.1/internal")).toThrow("private/internal");
    });

    it("blocks 192.168.x.x private range", () => {
      expect(() => validateUrl("http://192.168.1.1/admin")).toThrow("private/internal");
    });

    it("blocks 169.254.x.x link-local", () => {
      expect(() => validateUrl("http://169.254.169.254/latest/meta-data")).toThrow("private/internal");
    });

    it("blocks 0.0.0.0", () => {
      expect(() => validateUrl("http://0.0.0.0/")).toThrow("localhost/loopback");
    });

    it("blocks [::1] IPv6 loopback", () => {
      expect(() => validateUrl("http://[::1]/admin")).toThrow("localhost/loopback");
    });

    it("blocks .local hostnames", () => {
      expect(() => validateUrl("http://myservice.local/api")).toThrow("internal network");
    });

    it("blocks .internal hostnames", () => {
      expect(() => validateUrl("http://db.internal/query")).toThrow("internal network");
    });

    it("allows public IP addresses", () => {
      const parsed = validateUrl("http://8.8.8.8/path");
      expect(parsed.hostname).toBe("8.8.8.8");
    });

    it("allows public hostnames", () => {
      const parsed = validateUrl("https://api.example.com/data");
      expect(parsed.hostname).toBe("api.example.com");
    });

    // CRLF header injection tests (via proxyFetch integration — tested at validateUrl level here for URL-based attacks)
    it("blocks IPv4-mapped IPv6 bypass", () => {
      expect(() => validateUrl("http://[::ffff:127.0.0.1]/admin")).toThrow("private/internal");
    });

    it("blocks CGNAT range 100.64.0.0/10", () => {
      expect(() => validateUrl("http://100.64.0.1/admin")).toThrow("private/internal");
    });
  });
});
