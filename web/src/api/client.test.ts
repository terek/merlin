import { describe, expect, test } from 'bun:test'
import { ApiError, buildQuery, get } from './client'

describe('buildQuery', () => {
  test('skips absent values, repeats arrays, escapes', () => {
    expect(buildQuery()).toBe('')
    expect(buildQuery({ a: undefined, b: null, c: '' })).toBe('')
    expect(buildQuery({ q: 'a b&c', limit: 5, x: true })).toBe('?q=a+b%26c&limit=5&x=true')
    expect(buildQuery({ kind: ['interactive', 'background'] })).toBe('?kind=interactive&kind=background')
  })
})

describe('get', () => {
  const withFetch = async (impl: typeof fetch, fn: () => Promise<void>) => {
    const orig = globalThis.fetch
    globalThis.fetch = impl
    try {
      await fn()
    } finally {
      globalThis.fetch = orig
    }
  }
  const json = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  test('parses a 2xx body', async () => {
    await withFetch(json(200, { x: 1 }), async () => {
      expect(await get<{ x: number }>('/api/x', { a: 1 })).toEqual({ x: 1 })
    })
  })

  test('throws ApiError with code, message and candidates', async () => {
    const body = {
      error: {
        code: 'ambiguous_id',
        message: 'give more',
        candidates: [{ key: { harness: 'claude', id: 'a' }, project: '/p' }],
      },
    }
    await withFetch(json(409, body), async () => {
      const e = (await get('/api/x').catch((x) => x)) as ApiError
      expect(e).toBeInstanceOf(ApiError)
      expect(e.status).toBe(409)
      expect(e.code).toBe('ambiguous_id')
      expect(e.message).toBe('give more')
      expect(e.candidates).toHaveLength(1)
    })
  })

  test('a non-JSON error and a lost connection', async () => {
    await withFetch((async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch, async () => {
      const e = (await get('/api/x').catch((x) => x)) as ApiError
      expect(e.status).toBe(502)
      expect(e.message).toBe('HTTP 502')
      expect(e.candidates).toEqual([])
    })
    await withFetch(
      (async () => {
        throw new TypeError('failed')
      }) as unknown as typeof fetch,
      async () => {
        const e = (await get('/api/x').catch((x) => x)) as ApiError
        expect(e.status).toBe(0)
        expect(e.code).toBe('network')
      },
    )
  })
})
