import { type RefObject, useEffect, useLayoutEffect, useState } from 'react'

/**
 * The width of an element, followed as it resizes; null until it has been measured (before the first paint,
 * so that nothing is drawn or fetched for a guessed width).
 */
export function useMeasuredWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [w, setW] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(Math.floor(el.getBoundingClientRect().width) || 900)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width) || 900))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

/** The width of an element, followed as it resizes (900 before it is measured). */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  return useMeasuredWidth(ref) ?? 900
}

/** `value`, once it has held still for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}
