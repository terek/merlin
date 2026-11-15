// A session open inside the Overview (`?open=<harness>:<id>`, docs/ui.md section 10b, "A session in place"): a
// sticky paginator row that walks the list's rows in their order, and under it the session's graph. The list
// itself stays mounted behind it (Table), so closing puts it back as it was.

import { useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useHarness } from '../../api/harnesses'
import { sessionQuery, useSession } from '../../api/queries'
import type { OverviewLane } from '../../api/types'
import { cn } from '../../lib/cn'
import { resumeCommand } from '../../lib/paths'
import { sessionTitle } from '../../lib/session'
import { isTyping, useShortcut } from '../../shell/useShortcut'
import { CopyButton, HarnessIcon, IconButton, Money } from '../../ui'
import { closedSearch, focusSearch, type Key, positionIn } from './focus'
import { laneHead } from './model'
import { SessionView } from './SessionView'

export function SessionFocus({
  open,
  rows,
  sp,
}: {
  open: Key
  /** The list's rows, in the order the table draws them. */
  rows: readonly OverviewLane[]
  sp: URLSearchParams
}) {
  const navigate = useNavigate()
  const { hash } = useLocation()
  const search = sp.toString()
  const detail = useSession(open.harness, open.id, { messages: true }).data
  // an id prefix (an old link) is the session it resolves to
  const key: Key = detail ? detail.summary.key : open
  const at = positionIn(rows, key)
  const lane = at ? rows.find((l) => l.harness === key.harness && l.id === key.id) : undefined
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
  const command = resumeCommand(lane?.project ?? detail?.summary.cwd ?? detail?.summary.project, key.id, resume)
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
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-line border-b bg-surface px-3 text-sec">
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
        <HarnessIcon harness={key.harness} size={13} />
        <span className="min-w-0 truncate font-medium text-fg" title={title}>
          {title}
        </span>
        {lane && <Money usd={lane.usd} className="shrink-0" />}
        {command && <CopyButton text={command} label="Copy the resume command" />}
        <span className="flex-1" />
        <IconButton label="Close (Esc)" onClick={() => goTo(null)} className="size-6">
          <X size={15} />
        </IconButton>
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
        />
      </div>
    </div>
  )
}
