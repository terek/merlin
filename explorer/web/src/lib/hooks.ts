// Small React hooks shared by the primitives and the views.

import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** The current time, re-rendering once a minute (for relative times). */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/** `value`, but only after it has stayed the same for `ms` (search boxes: 200). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

/** True once `active` has been true for `ms` (skeletons appear after 200 ms, not at once). */
export function useDelayed(active: boolean, ms = 200): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!active) {
      setLate(false)
      return
    }
    const id = setTimeout(() => setLate(true), ms)
    return () => clearTimeout(id)
  }, [active, ms])
  return active && late
}

/**
 * Whether an element is within `rootMargin` of the viewport. Use the returned callback as `ref`.
 * `once`: stays true after the first time (mount `Prose` near the viewport and keep it);
 * otherwise it follows the element. Infinite lists: put a sentinel at the end and fetch when true.
 */
export function useInView<T extends Element = HTMLDivElement>(
  opts: { rootMargin?: string; once?: boolean } = {},
): [(el: T | null) => void, boolean] {
  const { rootMargin = '400px', once = false } = opts
  const [inView, setInView] = useState(false)
  const obs = useRef<IntersectionObserver | null>(null)
  const ref = useCallback(
    (el: T | null) => {
      obs.current?.disconnect()
      obs.current = null
      if (!el) return
      if (typeof IntersectionObserver === 'undefined') {
        setInView(true)
        return
      }
      const o = new IntersectionObserver(
        (entries) => {
          const hit = entries.some((e) => e.isIntersecting)
          if (hit) {
            setInView(true)
            if (once) o.disconnect()
          } else if (!once) {
            setInView(false)
          }
        },
        { rootMargin },
      )
      o.observe(el)
      obs.current = o
    },
    [rootMargin, once],
  )
  useEffect(() => () => obs.current?.disconnect(), [])
  return [ref, inView]
}

/** Whether the content of `ref` is taller than its box (a line-clamped element has more text). */
export function useOverflows(ref: RefObject<HTMLElement | null>, active: boolean, dep?: unknown): boolean {
  const [over, setOver] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `dep` re-measures when the content changes
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !active) return
    const measure = () => setOver(el.scrollHeight > el.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, active, dep])
  return over
}

/** Sets `document.title` to "<title> · Explorer" while the component is mounted. */
export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · Explorer` : 'Explorer'
    return () => {
      document.title = 'Explorer'
    }
  }, [title])
}
