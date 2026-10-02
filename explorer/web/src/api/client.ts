// fetch wrapper for the JSON API.

import type { Candidate, ErrorBody } from './types'

/** A non-2xx answer (or no answer: status 0, code "network"). */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /** Set for `409 ambiguous_id`: the sessions the id prefix matches. */
  readonly candidates: Candidate[]

  constructor(status: number, code: string, message: string, candidates: Candidate[] = []) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.candidates = candidates
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError

export type ParamValue = string | number | boolean | null | undefined | readonly string[]
export type Params = Record<string, ParamValue>

/** Builds "?a=1&b=2". Absent, null and empty values are left out; an array repeats the key. */
export function buildQuery(params?: Params): string {
  if (!params) return ''
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    if (typeof v === 'object') {
      for (const item of v) q.append(k, item)
    } else {
      q.set(k, String(v))
    }
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** GET `path` (e.g. "/api/sessions") with query parameters, parsed as T. Throws ApiError. */
export async function get<T>(path: string, params?: Params, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(path + buildQuery(params), { headers: { Accept: 'application/json' }, signal })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiError(0, 'network', 'Cannot reach the Explorer daemon.')
  }
  if (res.ok) return (await res.json()) as T
  let body: Partial<ErrorBody> | undefined
  try {
    body = (await res.json()) as ErrorBody
  } catch {
    // not JSON (a proxy's error page, say)
  }
  const err = body?.error
  throw new ApiError(
    res.status,
    err?.code ?? `http_${res.status}`,
    err?.message ?? `HTTP ${res.status}`,
    err?.candidates,
  )
}
