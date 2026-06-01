/**
 * Helpers for converting Zod schemas into provider-specific JSON Schema dialects
 * and validating provider responses.
 */

import { toJSONSchema, type ZodError, type z } from 'zod'
import { SchemaParseError } from './provider.ts'

export type JsonSchemaDialect = 'openai' | 'gemini' | 'ollama'

/** Build a JSON Schema for the given Zod schema, cleaned for the target provider. */
export function toProviderSchema(schema: z.ZodType, dialect: JsonSchemaDialect): Record<string, unknown> {
  // toJSONSchema is built into Zod 4 and emits Draft 2020-12 with
  // additionalProperties: false on objects.
  const json = toJSONSchema(schema) as Record<string, unknown>

  // Always strip $schema — providers don't accept it.
  const cleaned = stripFields(json, ['$schema'])

  if (dialect === 'gemini') {
    // Gemini's responseSchema rejects additionalProperties.
    return stripFields(cleaned, ['additionalProperties'])
  }

  return cleaned
}

/**
 * Validate a raw model response against a Zod schema, throwing SchemaParseError
 * on bad JSON or schema mismatch. `parsed` may be either a JSON string (from
 * text completion) or a pre-parsed object (e.g. from a tool_use input block).
 */
export function validateResponse<T extends z.ZodType>(schema: T, parsed: unknown, raw: string): z.infer<T> {
  let value: unknown = parsed
  if (typeof parsed === 'string') {
    try {
      value = JSON.parse(parsed)
    } catch (err) {
      throw new SchemaParseError(`Provider returned non-JSON: ${err instanceof Error ? err.message : err}`, raw, err)
    }
  }

  const result = schema.safeParse(value)
  if (!result.success) {
    throw new SchemaParseError(`Schema validation failed: ${formatZodError(result.error)}`, raw, result.error)
  }
  return result.data
}

/** Recursively strip the given fields from a JSON-schema-shaped object. */
function stripFields(input: unknown, fields: string[]): Record<string, unknown> {
  const seen = new Map<unknown, Record<string, unknown>>()
  const visit = (val: unknown): unknown => {
    if (Array.isArray(val)) return val.map(visit)
    if (val && typeof val === 'object') {
      const cached = seen.get(val)
      if (cached) return cached
      const out: Record<string, unknown> = {}
      seen.set(val, out)
      for (const [k, v] of Object.entries(val)) {
        if (fields.includes(k)) continue
        out[k] = visit(v)
      }
      return out
    }
    return val
  }
  return visit(input) as Record<string, unknown>
}

function formatZodError(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
}
