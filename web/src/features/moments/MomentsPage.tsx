// The Moments page (docs/moments.md, "The page"): the guide next to the instruments. One timeline of your own story
// whose rows open in place (your moments, then what to try next), and the ideas not suggested yet. The personas, their
// reactions and the card to share are not shown for now (MomentCard and PersonaAvatar stay).

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMoments } from '../../api/queries'
import type { MomentsReport, MomentView } from '../../api/types'
import { cn } from '../../lib/cn'
import { plural } from '../../lib/format'
import { useDocumentTitle } from '../../lib/hooks'
import { markSeen } from '../../shell/momentsBadge'
import { PanelTab } from '../../shell/Panel'
import { useShortcut } from '../../shell/useShortcut'
import { EmptyState, FRAME_HEAD, FrameSection, QueryBoundary, Skeleton } from '../../ui'
import { bucketDays, formatSort, parseSort, type Sort } from './layout'
import { dateOf, MomentsKey, Timeline, tickPath } from './Timeline'

export function MomentsPage() {
  useDocumentTitle('Moments')
  const q = useMoments()
  return (
    <div className="h-full w-full overflow-y-auto bg-surface [scrollbar-gutter:stable]">
      <header className="border-line border-b px-4 py-3">
        <h1 className="text-page font-semibold">Moments</h1>
        <p className="text-sec text-muted">
          What your sessions say about how you work with coding agents, and what to try next. Worked out on this machine
          from your history, every time you open the page.
        </p>
      </header>
      <QueryBoundary
        query={q}
        isEmpty={(r) => r.sessions - r.scripted === 0}
        empty={
          <EmptyState title="No sessions yet">
            Moments come from the sessions you work in. Once Merlin has indexed a few, they show up here.
          </EmptyState>
        }
        skeleton={<Skeleton className="m-4 h-96" />}
      >
        {(r) => <Report report={r} />}
      </QueryBoundary>
    </div>
  )
}

function Report({ report }: { report: MomentsReport }) {
  const [hover, setHover] = useState<string | null>(null)
  // opening the page clears the count on its tab
  useEffect(() => markSeen(report), [report])
  const [hoverTick, setHoverTick] = useState<string | null>(null)
  const [selTick, setSelTick] = useState<string | null>(null)
  const navigate = useNavigate()
  const [sp, setSp] = useSearchParams()
  // the selected moment is view state: `?m=<id>`, replacing the history entry
  const m = sp.get('m')
  const next = report.suggestions.slice(0, 3)
  const pin =
    m && report.moments.some((x) => x.id === m && (x.status !== 'unseen' || next.some((s) => s.moment === x.id)))
      ? m
      : null
  const setPin = (id: string | null) =>
    setSp(
      (prev) => {
        const n = new URLSearchParams(prev)
        if (id) n.set('m', id)
        else n.delete('m')
        return n
      },
      { replace: true },
    )
  const sort = parseSort(sp.get('sort'))
  const setSort = (s: Sort) =>
    setSp(
      (prev) => {
        const n = new URLSearchParams(prev)
        const v = formatSort(s)
        if (v) n.set('sort', v)
        else n.delete('sort')
        return n
      },
      { replace: true },
    )
  const byId = useMemo(() => new Map(report.moments.map((m) => [m.id, m])), [report.moments])
  const [k, setK] = useState(1)
  const pinnedDays = pin && report.since ? bucketDays(byId.get(pin)?.days ?? [], report.since, k) : []
  useShortcut('Escape', () => setPin(null), { enabled: pin !== null })
  // while a moment is pinned: the arrows step through its days and Enter opens the chosen one
  useShortcut(
    ['ArrowLeft', 'ArrowRight'],
    (e) => {
      const i = pinnedDays.findIndex((d) => d.day === selTick)
      const n = pinnedDays.length
      const next = e.key === 'ArrowRight' ? (i < 0 ? 0 : Math.min(n - 1, i + 1)) : i < 0 ? n - 1 : Math.max(0, i - 1)
      setSelTick(pinnedDays[next].day)
    },
    { enabled: pinnedDays.length > 0 },
  )
  const selDay = pinnedDays.find((d) => d.day === selTick)
  useEffect(() => {
    if (!selDay?.example) return
    const open = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      const path = tickPath(selDay)
      if (path) navigate(path)
    }
    // in the capture phase, so that a focused marker does not take the Enter as a pin
    window.addEventListener('keydown', open, true)
    return () => window.removeEventListener('keydown', open, true)
  }, [selDay, navigate])
  const togglePin = (id: string) => {
    setSelTick(null)
    setPin(pin === id ? null : id)
  }
  const tickDay = hoverTick ?? (selDay ? selDay.day : null)
  const shown = useMemo(() => ({ ...report, suggestions: next }), [report, next])
  const more = report.moments.filter((m) => m.status === 'unseen' && !next.some((s) => s.moment === m.id))
  return (
    <div>
      <FrameSection title="Your history" className="border-b-0">
        <Timeline
          report={shown}
          hover={hover}
          pin={pin}
          onHover={setHover}
          onPin={togglePin}
          tickDay={tickDay}
          onTick={setHoverTick}
          onK={setK}
          sort={sort}
          onSort={setSort}
        />
        <PanelTab id="moments" title="Moments">
          <MomentsKey />
        </PanelTab>
      </FrameSection>
      {more.length > 0 && <MoreToTry moments={more} />}

      <p className="px-4 py-3 text-sec text-faint">
        From {plural(report.sessions - report.scripted, 'session')}
        {report.scripted > 0 && <> and {plural(report.scripted, 'scripted run')}</>}
        {report.since && <> since {dateOf(report.since, new Date(report.now))}</>}.
      </p>
    </div>
  )
}

function MoreToTry({ moments }: { moments: MomentView[] }) {
  return (
    <section className="border-line border-b">
      <details className="group px-4 py-2">
        <summary className={cn(FRAME_HEAD, 'flex min-h-6 cursor-pointer items-center gap-2 select-none')}>
          {moments.length} more to try
          <span className="normal-case tracking-normal">(ideas, not a checklist)</span>
        </summary>
        <ul className="mt-1 divide-y divide-line">
          {moments.map((m) => (
            <li key={m.id} className="py-2">
              <div className="text-body font-medium">{m.title}</div>
              <p className="text-sec text-muted">{m.try}</p>
              {m.detects && <p className="text-sec text-faint">{m.detects}</p>}
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}
