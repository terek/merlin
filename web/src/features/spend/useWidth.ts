import { type RefObject, useEffect, useState } from 'react'

/** The width of an element held in state (it may mount after this component does), followed as it resizes. */
export function useElementWidth(el: HTMLElement | null): number {
  const [w, setW] = useState(900)
  useEffect(() => {
    if (!el) return
    setW(Math.floor(el.getBoundingClientRect().width) || 900)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width) || 900))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return w
}

/** The width of an element, followed as it resizes. */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(900)
  useEffect(() => {
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
