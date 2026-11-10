// The event stream: one EventSource for the app, patching the query cache.

import { useQueryClient } from '@tanstack/react-query'
import { createContext, type ReactNode, useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import { keyString } from '../lib/session'
import { initialVersion, seeAvailable, seeVersion, type VersionState } from '../lib/version'
import { applyEvent } from './cache'
import type { EventMap, ScanProgress, SessionKey } from './types'

export type Connection = 'connecting' | 'live' | 'offline'

/** How long a row that changed through an event stays highlighted (the fade is in CSS). */
export const FLASH_MS = 900
/** A dropped stream shows as offline only after this long: a daemon restarting in place is back sooner. */
export const OFFLINE_GRACE_MS = 3000
/** Invalidations of projects, cost and session details are batched this long. */
const INVALIDATE_MS = 1500

type Listener = () => void

/** Small observable state shared through context: connection, scan progress, changed rows. */
export class EventStore {
  connection: Connection = 'connecting'
  progress: ScanProgress | null = null
  version: VersionState = initialVersion
  private offlineTimer: ReturnType<typeof setTimeout> | undefined
  private flashing = new Map<string, ReturnType<typeof setTimeout>>()
  private listeners = new Set<Listener>()

  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }
  private emit() {
    for (const l of this.listeners) l()
  }
  setConnection(c: Connection) {
    if (c === this.connection) return
    this.connection = c
    this.emit()
  }
  /** The stream broke: show `offline` only if it stays down for the grace period. */
  streamDropped() {
    if (this.connection === 'offline' || this.offlineTimer) return
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = undefined
      this.setConnection('offline')
    }, OFFLINE_GRACE_MS)
  }
  streamOpened() {
    clearTimeout(this.offlineTimer)
    this.offlineTimer = undefined
    this.setConnection('live')
  }
  setVersion(seen: string) {
    const next = seeVersion(this.version, seen)
    if (next === this.version) return
    this.version = next
    this.emit()
  }
  setAvailable(seen: string) {
    const next = seeAvailable(this.version, seen)
    if (next === this.version) return
    this.version = next
    this.emit()
  }
  setProgress(p: ScanProgress) {
    this.progress = p
    this.emit()
  }
  flash(key: SessionKey) {
    const k = keyString(key)
    clearTimeout(this.flashing.get(k))
    this.flashing.set(
      k,
      setTimeout(() => {
        this.flashing.delete(k)
        this.emit()
      }, FLASH_MS),
    )
    this.emit()
  }
  isFlashing(key: SessionKey) {
    return this.flashing.has(keyString(key))
  }
  dispose() {
    clearTimeout(this.offlineTimer)
    this.offlineTimer = undefined
    for (const t of this.flashing.values()) clearTimeout(t)
    this.flashing.clear()
  }
}

const idleStore = new EventStore()
const Ctx = createContext<EventStore>(idleStore)

const NAMES = ['session-updated', 'session-state', 'session-missing', 'scan-progress', 'hello', 'update'] as const

export function EventsProvider({ children, url = '/api/events' }: { children: ReactNode; url?: string }) {
  const qc = useQueryClient()
  const store = useMemo(() => new EventStore(), [])

  useEffect(() => {
    const pending = new Map<string, { key: readonly unknown[]; timer: ReturnType<typeof setTimeout> }>()
    // Batches invalidations: a scan emits a session-updated per session, and projects and cost
    // would otherwise be refetched for each one.
    const invalidate = (key: readonly unknown[]) => {
      const id = JSON.stringify(key)
      if (pending.has(id)) return
      pending.set(id, {
        key,
        timer: setTimeout(() => {
          pending.delete(id)
          void qc.invalidateQueries({ queryKey: key })
        }, INVALIDATE_MS),
      })
    }

    // ?events=off keeps the page from opening the stream (headless screenshots wait for it).
    if (new URLSearchParams(location.search).get('events') === 'off') return
    let failed = false
    const es = new EventSource(url)
    es.onopen = () => {
      store.streamOpened()
      // Events are not replayed: after a reconnect, re-read everything that is on screen.
      if (failed) void qc.invalidateQueries()
      failed = false
    }
    es.onerror = () => {
      failed = true
      store.streamDropped()
    }
    for (const name of NAMES) {
      es.addEventListener(name, (e) => {
        let data: unknown
        try {
          data = JSON.parse((e as MessageEvent<string>).data)
        } catch {
          return
        }
        if (name === 'hello') {
          store.setVersion((data as EventMap['hello']).version)
          return
        }
        if (name === 'update') {
          store.setAvailable((data as EventMap['update']).version)
          return
        }
        if (name === 'scan-progress') {
          store.setProgress(data as ScanProgress)
          return
        }
        applyEvent(qc, name, data as EventMap[typeof name], { invalidate, changed: (k) => store.flash(k) })
      })
    }
    return () => {
      es.close()
      for (const p of pending.values()) clearTimeout(p.timer)
      store.dispose()
    }
  }, [qc, store, url])

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>
}

const useStore = () => useContext(Ctx)

/** `connecting` until the stream first opens, `live` while it is open, `offline` after an error that lasts over 3 s (it retries by itself). */
export function useConnection(): Connection {
  const s = useStore()
  return useSyncExternalStore(s.subscribe, () => s.connection)
}

/** The version this page loaded with and, once the daemon reports another, the one it was replaced by. */
export function useVersion(): VersionState {
  const s = useStore()
  return useSyncExternalStore(s.subscribe, () => s.version)
}

/** The latest scan-progress event, or null before the first. Indexing is under way while `pending > 0`. */
export function useScanProgress(): ScanProgress | null {
  const s = useStore()
  return useSyncExternalStore(s.subscribe, () => s.progress)
}

/** True for a moment after an event changed this session: add the `flash` class to its row. */
export function useJustChanged(key: SessionKey): boolean {
  const s = useStore()
  return useSyncExternalStore(s.subscribe, () => s.isFlashing(key))
}
