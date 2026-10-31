import { useEffect, useRef } from 'react'

/** Whether a key event comes from a field the user is typing into. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type)
  }
  return false
}

const SEQUENCE_MS = 1000

/**
 * Calls `handler` when a key (or a two-key sequence, written with a space: "g s") is pressed.
 * Keys are `KeyboardEvent.key` values: "/", "j", "Enter", "Escape". Ignored while the user types
 * in an input, textarea or select (unless `allowInInput`), and with ctrl, meta or alt held.
 * The event's default action is prevented when it matches (`preventDefault: false` to keep it).
 */
export function useShortcut(
  keys: string | string[],
  handler: (e: KeyboardEvent) => void,
  opts: { allowInInput?: boolean; preventDefault?: boolean; enabled?: boolean } = {},
) {
  const fn = useRef(handler)
  useEffect(() => {
    fn.current = handler
  })
  const { allowInInput = false, preventDefault = true, enabled = true } = opts
  const spec = Array.isArray(keys) ? keys.join('|') : keys

  useEffect(() => {
    if (!enabled) return
    const combos = spec.split('|').map((k) => k.split(' '))
    let buffer: string[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
      if (!allowInInput && isTyping(e.target)) {
        buffer = []
        return
      }
      if (e.key === 'Shift') return
      buffer = [...buffer, e.key].slice(-3)
      clearTimeout(timer)
      timer = setTimeout(() => {
        buffer = []
      }, SEQUENCE_MS)
      for (const c of combos) {
        if (buffer.length >= c.length && c.every((k, i) => buffer[buffer.length - c.length + i] === k)) {
          buffer = []
          if (preventDefault) e.preventDefault()
          fn.current(e)
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearTimeout(timer)
    }
  }, [spec, allowInInput, preventDefault, enabled])
}
