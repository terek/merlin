import { useEffect, useMemo, useState } from 'react'
import { LABEL_SIZE, labelWidth } from './layout'

/**
 * Real text widths from a canvas, with the page's font, cached per string and weight. Re-made once the fonts have
 * loaded, so the widths follow the font that is really drawn. Without a canvas it falls back to the estimate.
 */
export function useLabelMeasure(): (text: string, weight?: number) => number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let live = true
    document.fonts?.ready.then(() => live && setVersion((v) => v + 1))
    return () => {
      live = false
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the version re-makes the cache when fonts load
  return useMemo(() => {
    let ctx: CanvasRenderingContext2D | null = null
    try {
      ctx = document.createElement('canvas').getContext('2d')
    } catch {
      ctx = null
    }
    const family = typeof document === 'undefined' ? 'sans-serif' : getComputedStyle(document.body).fontFamily
    const cache = new Map<string, number>()
    return (text: string, weight = 400) => {
      if (!ctx) return labelWidth(text)
      const key = `${weight}|${text}`
      let w = cache.get(key)
      if (w === undefined) {
        ctx.font = `${weight} ${LABEL_SIZE}px ${family}`
        w = Math.ceil(ctx.measureText(text).width)
        cache.set(key, w)
      }
      return w
    }
  }, [version])
}
