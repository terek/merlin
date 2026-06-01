import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { SchemaParseError } from '../src/provider.ts'
import { toProviderSchema, validateResponse } from '../src/schema-utils.ts'

describe('toProviderSchema', () => {
  const schema = z.object({
    name: z.string(),
    tags: z.array(z.string()).optional(),
  })

  test('strips $schema for all dialects', () => {
    for (const d of ['openai', 'gemini', 'ollama'] as const) {
      const out = toProviderSchema(schema, d)
      expect(out.$schema).toBeUndefined()
    }
  })

  test('keeps additionalProperties for OpenAI / Ollama', () => {
    for (const d of ['openai', 'ollama'] as const) {
      const out = toProviderSchema(schema, d)
      expect(out.additionalProperties).toBe(false)
    }
  })

  test('strips additionalProperties for Gemini (recursive)', () => {
    const nested = z.object({ outer: z.object({ inner: z.string() }) })
    const out = toProviderSchema(nested, 'gemini')
    expect(out.additionalProperties).toBeUndefined()
    const outer = (out.properties as Record<string, Record<string, unknown>>).outer
    expect(outer.additionalProperties).toBeUndefined()
  })

  test('preserves required, properties, and types', () => {
    const out = toProviderSchema(schema, 'openai')
    expect(out.type).toBe('object')
    expect(out.required).toEqual(['name'])
    const props = out.properties as Record<string, { type: string }>
    expect(props.name.type).toBe('string')
    expect(props.tags.type).toBe('array')
  })
})

describe('validateResponse', () => {
  const schema = z.object({ a: z.string(), b: z.number() })

  test('parses JSON string then validates', () => {
    const out = validateResponse(schema, '{"a":"x","b":7}', '{"a":"x","b":7}')
    expect(out).toEqual({ a: 'x', b: 7 })
  })

  test('accepts already-parsed object (Anthropic tool_use input)', () => {
    const out = validateResponse(schema, { a: 'x', b: 7 }, 'raw')
    expect(out).toEqual({ a: 'x', b: 7 })
  })

  test('throws SchemaParseError on malformed JSON', () => {
    expect(() => validateResponse(schema, 'not json', 'not json')).toThrow(SchemaParseError)
  })

  test('throws SchemaParseError on schema mismatch with field path in message', () => {
    try {
      validateResponse(schema, { a: 'x', b: 'wrong' }, 'raw')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaParseError)
      expect((err as Error).message).toContain('b:')
    }
  })

  test('SchemaParseError carries the raw payload', () => {
    try {
      validateResponse(schema, 'bogus', 'bogus')
    } catch (err) {
      expect((err as SchemaParseError).raw).toBe('bogus')
    }
  })
})
