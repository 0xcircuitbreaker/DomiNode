import { z } from "zod";
import type { JsonSchemaObject, JsonSchemaProperty } from "./core.js";

function prop(p: JsonSchemaProperty): z.ZodTypeAny {
  let t: z.ZodTypeAny;
  if (p.enum) {
    t = z.enum(p.enum as unknown as [string, ...string[]]);
  } else if (p.type === "integer") {
    let n = z.number().int();
    if (p.minimum !== undefined) n = n.min(p.minimum);
    if (p.maximum !== undefined) n = n.max(p.maximum);
    t = n;
  } else if (p.type === "boolean") {
    t = z.boolean();
  } else {
    t = z.string();
  }
  return t.describe(p.description);
}

/** Convert a core tool's JSON schema into the equivalent zod object schema. */
export function toZod(schema: JsonSchemaObject): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [k, p] of Object.entries(schema.properties)) {
    shape[k] = schema.required.includes(k) ? prop(p) : prop(p).optional();
  }
  return z.object(shape).strict();
}
