// Scrolling to a turn and staying there while the layout settles.

/**
 * Scrolls to the element with `id` and keeps it at the top while the page reflows (text blocks
 * mount and change height). It lets go after `quietMs` without a layout change, after `maxMs` at
 * the latest, or as soon as the reader scrolls, clicks or types. Returns the cleanup. Calls `done`
 * when it lets go by itself.
 */
export function scrollToIdSettled(id: string, done?: () => void, quietMs = 1500, maxMs = 8000): () => void {
  if (!document.getElementById(id)) return () => {}
  let live = true
  let quiet: ReturnType<typeof setTimeout> | undefined
  const align = () => document.getElementById(id)?.scrollIntoView({ block: 'start' })
  const events = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const
  const release = () => {
    live = false
    ro?.disconnect()
    clearTimeout(quiet)
    clearTimeout(max)
    for (const e of events) window.removeEventListener(e, stop)
  }
  const stop = () => {
    if (!live) return
    release()
    done?.()
  }
  const ro =
    typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => {
          if (!live) return
          align()
          clearTimeout(quiet)
          quiet = setTimeout(stop, quietMs)
        })
  ro?.observe(document.body)
  const max = setTimeout(stop, maxMs)
  quiet = setTimeout(stop, quietMs)
  for (const e of events) window.addEventListener(e, stop, { passive: true })
  align()
  return release
}
