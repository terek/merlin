import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type MappingAxis, type TimeBoundary, timeBoundaries } from './mappingBoundaries'

interface Endpoint {
  element: SVGSVGElement
  axis: MappingAxis
}

const MappingContext = createContext<{ report: (endpoint: Endpoint | null) => void; active: boolean } | null>(null)

export const useMappingSource = () => useContext(MappingContext)?.active ?? false

/** The locator reports its own SVG and axis, so padding, compression and responsive widths stay exact. */
export function useTimeMapping(element: RefObject<SVGSVGElement | null>, axis: MappingAxis) {
  const report = useContext(MappingContext)?.report
  useLayoutEffect(() => {
    if (!report || !element.current) return
    report({ element: element.current, axis })
    return () => report(null)
  }, [report, element, axis])
}

interface Bridge {
  points: TimeBoundary[]
  y0: number
  y1: number
}

/** Focus-local overlay: measured against the real graph elements, clipped when its locator scrolls away. */
export function TimeMapping({
  source,
  axis,
  children,
}: {
  source: RefObject<HTMLDivElement | null>
  axis: MappingAxis | null
  children: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const [target, setTarget] = useState<Endpoint | null>(null)
  const report = useCallback((endpoint: Endpoint | null) => setTarget(endpoint), [])
  const context = useMemo(() => ({ report, active: axis !== null }), [report, axis])
  const [bridge, setBridge] = useState<Bridge | null>(null)
  useLayoutEffect(() => {
    const container = root.current
    const from = source.current
    if (!container || !from || !axis || !target) {
      setBridge(null)
      return
    }
    let frame = 0
    const measure = () => {
      const r = container.getBoundingClientRect()
      const a = from.getBoundingClientRect()
      const b = target.element.getBoundingClientRect()
      // The source remains sticky. Once the locator reaches it, connections would point backwards or
      // attach to hidden content; hide them until the locator is fully below the head again.
      if (b.top < a.bottom + 4 || b.bottom > r.bottom || b.width <= 0) {
        setBridge(null)
        return
      }
      const points = timeBoundaries(
        { ...axis, x: (t) => a.left - r.left + axis.x(t) },
        { ...target.axis, x: (t) => b.left - r.left + target.axis.x(t) },
      )
      setBridge({ points, y0: a.bottom - r.top, y1: b.top - r.top })
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    measure()
    const observer = new ResizeObserver(schedule)
    observer.observe(container)
    observer.observe(from)
    observer.observe(target.element)
    container.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      container.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [source, axis, target])

  return (
    <MappingContext value={context}>
      <div ref={root} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {children}
        {bridge && bridge.points.length > 0 && (
          // biome-ignore lint/a11y/noSvgWithoutTitle: decoration connecting the same timestamps on two axes
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0 size-full overflow-hidden"
            data-testid="time-mapping"
          >
            {bridge.points.map((p) => (
              <g
                key={p.t}
                data-time={p.t}
                data-source-x={p.source}
                data-target-x={p.target}
                stroke="var(--muted)"
                strokeOpacity={0.45}
                fill="none"
              >
                <path d={`M${p.source} ${bridge.y0}L${p.target} ${bridge.y1}`} strokeWidth={1} />
                <path d={`M${p.source - 2} ${bridge.y0}h4M${p.target - 2} ${bridge.y1}h4`} strokeWidth={1.5} />
              </g>
            ))}
          </svg>
        )}
      </div>
    </MappingContext>
  )
}
