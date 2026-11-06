const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const REDACTED = "[REDACTED]";

/**
 * Wraps a credential returned exactly once by the server (new API key, node key).
 * String conversion, JSON serialisation and util.inspect all print "[REDACTED]";
 * call reveal() to get the value. The raw value lives in a private field.
 */
export class Secret {
  readonly #value: string;
  constructor(value: string) { this.#value = value; }
  reveal(): string { return this.#value; }
  /** First 8 characters, safe for logs (security.md: show at most 8 chars). */
  get prefix(): string { return this.#value.slice(0, 8); }
  toString(): string { return REDACTED; }
  toJSON(): string { return REDACTED; }
  [INSPECT](): string { return `Secret(${REDACTED})`; }
}

export { INSPECT as inspectSymbol, REDACTED };
