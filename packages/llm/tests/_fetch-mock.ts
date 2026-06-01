/**
 * Test helper: install a fake `globalThis.fetch` that records requests and
 * returns canned JSON. Used by provider tests to verify request shape and
 * response handling without hitting the network.
 */

interface RecordedRequest {
  url: string
  body: unknown
  headers: Record<string, string> | undefined
  method: string | undefined
}

export interface FetchMock {
  requests: RecordedRequest[]
  setResponse: (body: unknown, init?: { status?: number }) => void
  /** Set a function that returns the response based on the request. */
  setResponder: (fn: (req: RecordedRequest) => { body: unknown; status?: number }) => void
  /**
   * Reply with a streamed SSE body. `events` are joined with `\n\n` and a
   * trailing blank line is appended so the parser sees complete events.
   */
  setSseResponse: (events: string[], init?: { status?: number }) => void
}

const ORIGINAL = globalThis.fetch

export function installFetchMock(): FetchMock {
  const requests: RecordedRequest[] = []
  let nextBody: unknown = {}
  let nextStatus = 200
  let responder: ((req: RecordedRequest) => { body: unknown; status?: number }) | null = null
  let sseEvents: string[] | null = null

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let parsedBody: unknown = null
    if (init?.body) {
      const raw = typeof init.body === 'string' ? init.body : ''
      try {
        parsedBody = raw ? JSON.parse(raw) : null
      } catch {
        parsedBody = raw
      }
    }
    const headers = normalizeHeaders(init?.headers)
    const req: RecordedRequest = {
      url: typeof input === 'string' ? input : input.toString(),
      body: parsedBody,
      headers,
      method: init?.method,
    }
    requests.push(req)

    if (sseEvents) {
      const events = sseEvents
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          for (const ev of events) controller.enqueue(encoder.encode(`${ev}\n\n`))
          controller.close()
        },
      })
      return new Response(stream, {
        status: nextStatus,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }

    const r = responder ? responder(req) : { body: nextBody, status: nextStatus }
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  return {
    requests,
    setResponse(body, init) {
      nextBody = body
      nextStatus = init?.status ?? 200
      responder = null
      sseEvents = null
    },
    setResponder(fn) {
      responder = fn
      sseEvents = null
    },
    setSseResponse(events, init) {
      sseEvents = events
      nextStatus = init?.status ?? 200
      responder = null
    },
  }
}

export function restoreFetch(): void {
  globalThis.fetch = ORIGINAL
}

function normalizeHeaders(h: HeadersInit | undefined): Record<string, string> | undefined {
  if (!h) return undefined
  if (h instanceof Headers) {
    const out: Record<string, string> = {}
    h.forEach((v, k) => {
      out[k] = v
    })
    return out
  }
  if (Array.isArray(h)) return Object.fromEntries(h)
  return h as Record<string, string>
}
