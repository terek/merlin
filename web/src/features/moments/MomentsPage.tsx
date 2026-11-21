// The Moments page (docs/moments.md, "The page"): the guide next to the instruments. A timeline of your own story,
// what to try next (each with the place it shows), your moments as a list and the ones not seen yet. The personas, their
// reactions and the card to share are not shown for now (MomentCard and PersonaAvatar stay).

import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useMoments } from '../../api/queries'
import type { MomentHit, MomentsReport, MomentView } from '../../api/types'
import { cn } from '../../lib/cn'
import { plural } from '../../lib/format'
import { useDocumentTitle } from '../../lib/hooks'
import { sessionPath } from '../../lib/paths'
import { markSeen } from '../../shell/momentsBadge'
import { useShortcut } from '../../shell/useShortcut'
import { EmptyState, FRAME_HEAD, FrameSection, QueryBoundary, RelTime, SegmentedControl, Skeleton } from '../../ui'
import { bucketDays, seenMoments } from './layout'
import { dateOf, Glyph, Readout, Timeline, tickPath, timesInWeeks } from './Timeline'

export function MomentsPage() {
  useDocumentTitle('Moments')
  const q = useMoments()
  return (
    <div>
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

/** A hit as a link into the session, at its turn. */
function hitPath(h: MomentHit): string {
  return sessionPath(h.session, h.turn !== undefined ? `t${h.turn}` : undefined)
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
  const pin = m && report.moments.some((x) => x.id === m && x.status !== 'unseen') ? m : null
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
  const view: 'moments' | 'next' = sp.get('view') === 'next' ? 'next' : 'moments'
  // the lower part's mode is view state: in the URL, replacing the entry rather than adding one
  const setView = (v: 'moments' | 'next') =>
    setSp(
      (prev) => {
        const n = new URLSearchParams(prev)
        if (v === 'next') n.set('view', 'next')
        else n.delete('view')
        return n
      },
      { replace: true },
    )
  const [scrollTo, setScrollTo] = useState<string | null>(null)
  useEffect(() => {
    if (!scrollTo || view !== 'next') return
    document.getElementById(scrollTo)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    setScrollTo(null)
  }, [scrollTo, view])
  const showNext = (id: string | null) => {
    setView('next')
    setScrollTo(id ? `next-${id}` : 'moments-lower')
  }
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
  const seen = useMemo(() => seenMoments(report.moments), [report.moments])
  const unseen = report.moments.filter((m) => m.status === 'unseen')
  const next = report.suggestions.slice(0, 3)
  return (
    <div>
      <FrameSection title="Your history">
        <Timeline
          report={report}
          hover={hover}
          pin={pin}
          onHover={setHover}
          onPin={togglePin}
          tickDay={tickDay}
          onTick={setHoverTick}
          onNext={showNext}
          onK={setK}
        />
        <Readout report={report} hover={hover} pin={pin} tickDay={tickDay} k={k} onClear={() => setPin(null)} />
      </FrameSection>

      <div id="moments-lower">
        <FrameSection
          title={view === 'next' ? "What's next" : `Your moments (${seen.length})`}
          actions={
            (next.length > 0 || unseen.length > 0) && seen.length > 0 ? (
              <SegmentedControl
                label="Lower part"
                value={view}
                onChange={setView}
                options={[
                  { value: 'moments', label: 'Your moments' },
                  { value: 'next', label: "What's next" },
                ]}
              />
            ) : undefined
          }
          className="border-b-0"
        >
          {view === 'moments' || (next.length === 0 && unseen.length === 0) ? (
            <ul className="-mx-2">
              {seen.map((m) => (
                <MomentRow
                  key={m.id}
                  moment={m}
                  now={new Date(report.now)}
                  active={pin === m.id || hover === m.id}
                  pinned={pin === m.id}
                  onHover={setHover}
                  onPin={togglePin}
                />
              ))}
            </ul>
          ) : (
            <ul className="divide-y divide-line">
              {next.map((s) => {
                const m = byId.get(s.moment)
                return m ? <NextRow key={s.moment} moment={m} reason={s.reason} example={s.example} /> : null
              })}
            </ul>
          )}
        </FrameSection>
        {view === 'next' && unseen.length > 0 && <MoreToTry moments={unseen} />}
      </div>

      <p className="px-4 py-3 text-sec text-faint">
        From {plural(report.sessions - report.scripted, 'session')}
        {report.scripted > 0 && <> and {plural(report.scripted, 'scripted run')}</>}
        {report.since && <> since {dateOf(report.since, new Date(report.now))}</>}.
      </p>
    </div>
  )
}

function NextRow({ moment, reason, example }: { moment: MomentView; reason?: string; example?: MomentHit }) {
  return (
    <li id={`next-${moment.id}`} className="space-y-0.5 py-2">
      <div className="text-body font-semibold">{moment.title}</div>
      {reason && <p className="text-body">{reason}</p>}
      <p className="text-sec text-muted">{moment.try}</p>
      {reason && example && (
        <p className="text-sec">
          <Link to={hitPath(example)}>See it in your sessions →</Link>
        </p>
      )}
    </li>
  )
}

function MomentRow({
  moment: m,
  now,
  active,
  pinned,
  onHover,
  onPin,
}: {
  moment: MomentView
  now: Date
  active: boolean
  pinned: boolean
  onHover: (id: string | null) => void
  onPin: (id: string) => void
}) {
  const latest = m.examples?.[0]
  const [how, setHow] = useState(false)
  return (
    <li
      className={cn(
        'rounded-card px-2 py-1 hover:bg-surface-2',
        active && 'bg-surface-2',
        pinned && 'bg-[var(--chip-sel)]',
      )}
      onMouseEnter={() => onHover(m.id)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-pressed={pinned}
          onClick={() => onPin(m.id)}
          onFocus={() => onHover(m.id)}
          onBlur={() => onHover(null)}
          className="flex h-7 shrink-0 items-center gap-2.5 text-left"
        >
          <Glyph status={m.status} />
          <span
            className={cn('w-56 shrink-0 truncate text-body', pinned ? 'font-semibold text-accent' : 'font-medium')}
          >
            {m.title}
          </span>
          <span className="w-28 shrink-0 text-sec text-muted">since {dateOf(m.first, now)}</span>
          <span className="w-44 shrink-0 text-sec text-muted tabular-nums">{timesInWeeks(m)}</span>
          <span className="w-28 shrink-0 text-sec text-faint">
            {m.last && (
              <>
                last <RelTime time={m.last} />
              </>
            )}
          </span>
        </button>
        {latest && (
          <Link to={hitPath(latest)} className="min-w-0 flex-1 truncate text-sec" title={latest.note}>
            {latest.note || 'Open the latest'} →
          </Link>
        )}
      </div>
      <p className="ml-[19px] flex items-baseline gap-2 pb-0.5 text-sec text-muted">
        <span className="min-w-0 truncate" title={m.what}>
          {m.what}
        </span>
        {m.detects && (
          <button
            type="button"
            aria-expanded={how}
            onClick={() => setHow(!how)}
            className="shrink-0 text-faint underline decoration-dotted hover:text-muted"
          >
            how
          </button>
        )}
      </p>
      {how && m.detects && <p className="ml-[19px] pb-0.5 text-sec text-faint">{m.detects}</p>}
    </li>
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
