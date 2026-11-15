// A session open inside the Overview (`?open=<harness>:<id>`, docs/ui.md section 10b, "A session in place"): a
// sticky head that is the session's own row of the list (the same text line and row graph, on the list's axis, at
// the list's geometry) with the paginator in the place of the figures, and under it the session's graph in the
// frame of the page. The list itself stays mounted behind it (Table), so closing puts it back as it was.

import { useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useHarness } from '../../api/harnesses'
import { sessionQuery, useSession } from '../../api/queries'
import type { OverviewLane } from '../../api/types'
import { cn } from '../../lib/cn'
import { resumeCommand } from '../../lib/paths'
import { sessionTitle } from '../../lib/session'
import { isTyping, useShortcut } from '../../shell/useShortcut'
import { HarnessIcon, IconButton, Money } from '../../ui'
import { TimeMapping } from '../spend/TimeMapping'
import { closedSearch, focusSearch, headRow, type Key, lifeRange, outsideNote, positionIn } from './focus'
import {
  type Axis,
  bandLabel,
  folderText,
  laneDescription,
  laneHead,
  sessionKey,
  sessionStretch,
  windowBand,
} from './model'
import { CELL_PAD, FolderCell, laneData, RowGraph, SessionText } from './RowParts'
import { SessionView } from './SessionView'
import type { LockoutSpan } from './windows'

/** What the head needs of the list to draw the session's row the way the list does. */
export interface RowContext {
  /** Every session of the range (the list's rows are the ones the scope and the search leave). */
  lanes: readonly OverviewLane[]
  /** The list's linear time axis, at the width its session column has. */
  axis: Axis
  pxPerTok: number
  /** The list's scrollbar: the head gives up as much, so that the axis is the same. */
  padRight: number
  /** The structured block's width: the paginator takes its place. */
  blockW: number
  home: string | undefined
  refusals: ReadonlyMap<string, readonly number[]>
  lockouts: ReadonlyMap<string, readonly LockoutSpan[]>
}

/** The window of the session's graph in true time, drawn on the head's row graph as a band. */
function WindowBand({ axis, lo, hi }: { axis: Axis; lo: number; hi: number }) {
  const b = windowBand(axis, lo, hi)
  if (!b) return null
  const mid = 9
  const mark = (x: number, dir: 1 | -1) => `M${x + 4 * dir},${mid - 4}L${x},${mid}L${x + 4 * dir},${mid + 4}`
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decoration; the Spend section says what it shows
    <svg
      width={axis.width}
      height="100%"
      className="pointer-events-none absolute top-0 left-0"
      aria-hidden
      data-testid="focus-band"
    >
      {/* an outline, not a fill: a lockout is a shaded block on the same row, and the two must not read alike */}
      <rect x={b.x0} y={0} width={b.x1 - b.x0} height="100%" fill="var(--accent)" fillOpacity={0.04} />
      <rect
        x={b.x0 + 0.5}
        y={0.5}
        width={Math.max(0, b.x1 - b.x0 - 1)}
        style={{ height: 'calc(100% - 1px)' }}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1}
      />
      {b.before && <path d={mark(b.x0 + 1, 1)} fill="none" stroke="var(--accent)" strokeWidth={1.25} />}
      {b.after && <path d={mark(b.x1 - 1, -1)} fill="none" stroke="var(--accent)" strokeWidth={1.25} />}
    </svg>
  )
}

export function SessionFocus({
  open,
  rows,
  sp,
  ctx,
}: {
  open: Key
  /** The list's rows, in the order the table draws them. */
  rows: readonly OverviewLane[]
  sp: URLSearchParams
  ctx: RowContext
}) {
  const navigate = useNavigate()
  const { hash } = useLocation()
  const search = sp.toString()
  const detail = useSession(open.harness, open.id, { messages: true }).data
  // an id prefix (an old link) is the session it resolves to
  const key: Key = detail ? detail.summary.key : open
  const at = positionIn(rows, key)
  // the session's row of the list; or, outside the list (the scope, the search), its lane of the range
  const lane = ctx.lanes.find((l) => l.harness === key.harness && l.id === key.id)

  // the graph's window in true time (the head draws it), and a stretch asked for by a click on the head's row
  // graph: both in state, never in the address; both are the session's own (the key says whose)
  const own = `${key.harness}:${key.id}`
  const [shown, setShown] = useState<{ k: string; lo: number; hi: number } | null>(null)
  const [ask, setAsk] = useState<{ k: string; lo: number; hi: number; n: number } | null>(null)
  const onWindow = useMemo(
    () => (lo: number, hi: number) =>
      setShown((w) => (w && w.k === own && w.lo === lo && w.hi === hi ? w : { k: own, lo, hi })),
    [own],
  )
  const resume = useHarness(key.harness).resume

  const hrefFor = (k: Key) => `/${focusSearch(search, k)}`
  const goTo = (k: Key | null) => navigate(k ? hrefFor(k) : `/${closedSearch(search)}`)
  const prev = at?.prev ?? null
  const next = at?.next ?? null

  useShortcut('[', () => prev && goTo(prev), { enabled: prev !== null })
  useShortcut(']', () => next && goTo(next), { enabled: next !== null })
  // Esc closes what nothing else took: the graph's own Esc (it takes a pinned turn back) has already run
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isTyping(e.target)) return
      e.preventDefault()
      navigate(`/${closedSearch(search)}`)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [navigate, search])

  // the neighbours are fetched once this one is on screen, so that ‹ and › open at once
  const qc = useQueryClient()
  const loaded = detail !== undefined
  useEffect(() => {
    if (!loaded) return
    for (const k of [prev, next]) if (k) void qc.prefetchQuery(sessionQuery(k.harness, k.id, true))
  }, [loaded, prev, next, qc])

  const title = lane ? laneHead(lane) : detail ? sessionTitle(detail.summary) : ''
  const dir = lane?.dir ?? detail?.summary.cwd
  const command = resumeCommand(lane?.project ?? detail?.summary.cwd ?? detail?.summary.project, key.id, resume)
  const { axis } = ctx
  const summaryGraph = useRef<HTMLDivElement>(null)
  const mappingAxis = useMemo(
    () => (lane ? { lo: axis.fromMs, hi: axis.toMs, x: (t: number) => (t - axis.fromMs) * axis.pxPerMs } : null),
    [lane, axis],
  )
  // a session with a lane is drawn as the list draws it; the note is for one without a lane, outside the range
  const rowGraph = lane
  const band = shown && shown.k === own ? shown : null
  const arrow = (to: Key | null, label: string, icon: React.ReactNode) => (
    <IconButton
      label={label}
      disabled={to === null}
      onClick={() => to && goTo(to)}
      className={cn('size-6', to === null && 'opacity-35 hover:bg-transparent hover:text-muted')}
    >
      {icon}
    </IconButton>
  )
  const paginator = (
    <div className="flex items-center gap-1 text-sec">
      {at ? (
        <>
          {arrow(prev, 'Previous session ([)', <ChevronLeft size={15} />)}
          <span className="whitespace-nowrap font-mono text-muted">
            {at.n} of {at.total}
          </span>
          {arrow(next, 'Next session (])', <ChevronRight size={15} />)}
        </>
      ) : (
        <span className="whitespace-nowrap text-muted">Not in this list</span>
      )}
      <span className="flex-1" />
      {lane && <Money usd={lane.usd} className="mr-1 shrink-0" />}
      <IconButton label="Close (Esc)" onClick={() => goTo(null)} className="size-6">
        <X size={15} />
      </IconButton>
    </div>
  )
  const members = detail?.family.members ?? []
  const [from, to] = lifeRange(
    [lane?.startedAt, detail?.summary.startedAt, ...members.map((m) => m.startedAt)],
    [lane?.lastActivityAt, detail?.summary.lastActivityAt, ...members.map((m) => m.lastActivityAt)],
  )
  const below = headRow(lane !== undefined, [from, to], axis)
  return (
    <TimeMapping key={`${open.harness}:${open.id}`} source={summaryGraph} axis={mappingAxis}>
      <div className="flex shrink-0 border-line border-b bg-surface" style={{ paddingRight: ctx.padRight }}>
        <div className="min-w-0 flex-1 overflow-hidden pb-1" style={{ paddingInline: CELL_PAD }}>
          <SessionText
            mark={<HarnessIcon harness={key.harness} size={13} />}
            head={<span className="font-semibold text-fg">{title}</span>}
            headText={title}
            desc={lane ? laneDescription(lane) : ''}
            note=""
            folder={<FolderCell text={folderText(dir, ctx.home)} path={dir || 'No folder'} command={command} />}
          />
          {rowGraph ? (
            <div
              ref={summaryGraph}
              data-testid="focus-summary-axis"
              data-from-ms={axis.fromMs}
              data-to-ms={axis.toMs}
              className="relative cursor-pointer"
              style={{ width: axis.width }}
              onMouseMove={(e) => {
                e.currentTarget.title = `Zoom to ${bandLabel(axis, e.clientX - e.currentTarget.getBoundingClientRect().left)}`
              }}
              onClick={(e) => {
                if (e.button !== 0) return
                const w = sessionStretch(rowGraph, axis, e.clientX - e.currentTarget.getBoundingClientRect().left)
                if (w) setAsk((a) => ({ k: own, lo: w[0], hi: w[1], n: (a?.n ?? 0) + 1 }))
              }}
            >
              <RowGraph
                data={laneData(
                  rowGraph,
                  ctx.refusals.get(sessionKey(rowGraph.harness, rowGraph.id)),
                  ctx.lockouts.get(rowGraph.harness),
                )}
                axis={axis}
                pxPerTok={ctx.pxPerTok}
              />
              {band && <WindowBand axis={axis} lo={band.lo} hi={band.hi} />}
            </div>
          ) : (
            below === 'note' && <p className="py-1 text-meta text-muted">{outsideNote(from, to)}</p>
          )}
        </div>
        <div
          className="flex shrink-0 flex-col justify-center border-line border-l"
          style={{ width: ctx.blockW, paddingInline: CELL_PAD }}
        >
          {paginator}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <SessionView
          // the session's own state (pin, zoom, frame) is the session's: a new one starts fresh
          key={`${open.harness}:${open.id}`}
          harness={open.harness}
          id={open.id}
          search={search}
          hash={hash}
          hrefFor={hrefFor}
          onWindow={onWindow}
          zoomTo={ask && ask.k === own ? ask : undefined}
        />
      </div>
    </TimeMapping>
  )
}
