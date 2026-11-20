// The Moments page (docs/moments.md, "The page"): the guide next to the instruments. A timeline of your own story,
// what to try next (each with the place it shows), your moments as a list and the ones not seen yet. The personas, their
// reactions and the card to share are not shown for now (MomentCard and PersonaAvatar stay).

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMoments } from '../../api/queries'
import type { MomentHit, MomentsReport, MomentView } from '../../api/types'
import { cn } from '../../lib/cn'
import { plural } from '../../lib/format'
import { useDocumentTitle } from '../../lib/hooks'
import { sessionPath } from '../../lib/paths'
import { markSeen } from '../../shell/momentsBadge'
import { useShortcut } from '../../shell/useShortcut'
import { EmptyState, FRAME_HEAD, FrameSection, QueryBoundary, RelTime, Skeleton } from '../../ui'
import { seenMoments } from './layout'
import { dateOf, Glyph, Readout, Timeline, timesInWeeks } from './Timeline'

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
  const [pin, setPin] = useState<string | null>(null)
  // opening the page clears the count on its tab
  useEffect(() => markSeen(report), [report])
  useShortcut('Escape', () => setPin(null), { enabled: pin !== null })
  const togglePin = (id: string) => setPin((p) => (p === id ? null : id))
  const byId = useMemo(() => new Map(report.moments.map((m) => [m.id, m])), [report.moments])
  const seen = useMemo(() => seenMoments(report.moments), [report.moments])
  const unseen = report.moments.filter((m) => m.status === 'unseen')
  const next = report.suggestions.slice(0, 3)
  return (
    <div>
      <FrameSection title="Your history">
        <Timeline report={report} hover={hover} pin={pin} onHover={setHover} onPin={togglePin} />
        <Readout report={report} hover={hover} pin={pin} onHover={setHover} />
      </FrameSection>

      {next.length > 0 && (
        <FrameSection title="Next">
          <ul className="divide-y divide-line">
            {next.map((s) => {
              const m = byId.get(s.moment)
              return m ? <NextRow key={s.moment} moment={m} reason={s.reason} example={s.example} /> : null
            })}
          </ul>
        </FrameSection>
      )}

      {seen.length > 0 && (
        <FrameSection title={`Your moments (${seen.length})`}>
          <ul className="-mx-2">
            {seen.map((m) => (
              <MomentRow
                key={m.id}
                moment={m}
                now={new Date(report.now)}
                active={(hover ?? pin) === m.id}
                pinned={pin === m.id}
                onHover={setHover}
                onPin={togglePin}
              />
            ))}
          </ul>
        </FrameSection>
      )}

      {unseen.length > 0 && <MoreToTry moments={unseen} />}

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
    <li className="space-y-0.5 py-2">
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
  return (
    <li
      className={cn('flex items-center gap-3 rounded-card px-2 hover:bg-surface-2', active && 'bg-surface-2')}
      onMouseEnter={() => onHover(m.id)}
      onMouseLeave={() => onHover(null)}
    >
      <button
        type="button"
        aria-pressed={pinned}
        onClick={() => onPin(m.id)}
        onFocus={() => onHover(m.id)}
        onBlur={() => onHover(null)}
        title={m.what}
        className="flex h-8 shrink-0 items-center gap-2.5 text-left"
      >
        <Glyph status={m.status} />
        <span className="w-56 shrink-0 truncate text-body font-medium">{m.title}</span>
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
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}
