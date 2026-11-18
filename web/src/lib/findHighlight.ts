// Marks the term of a session's find in the texts under an element, with the CSS Custom Highlight API (`::highlight(find)`
// in styles.css): nothing in the element changes, so folded texts, links and markdown stay as they are. A browser
// without the API shows no marks; the hits themselves still step.

import { type RefObject, useEffect } from 'react'
import { matchRanges } from '../features/overview/find'

interface HighlightApi {
  highlights?: { set(name: string, h: unknown): void; delete(name: string): void }
}

/** Marks every occurrence of `term` (case-insensitive) in the text under `ref`, as the text changes. */
export function useFindHighlight(ref: RefObject<HTMLElement | null>, term: string) {
  useEffect(() => {
    const el = ref.current
    const api = (globalThis as { CSS?: HighlightApi }).CSS?.highlights
    const Highlight = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    if (!el || !api || !Highlight) return
    const needle = term.trim()
    const paint = () => {
      if (!needle) {
        api.delete('find')
        return
      }
      const ranges: Range[] = []
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent ?? ''
        for (const m of matchRanges(text, needle)) {
          const r = document.createRange()
          r.setStart(n, m.from)
          r.setEnd(n, m.to)
          ranges.push(r)
        }
      }
      if (ranges.length) api.set('find', new Highlight(...ranges))
      else api.delete('find')
    }
    paint()
    let frame = 0
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(paint)
    })
    mo.observe(el, { subtree: true, childList: true, characterData: true })
    return () => {
      mo.disconnect()
      cancelAnimationFrame(frame)
      api.delete('find')
    }
  }, [ref, term])
}
