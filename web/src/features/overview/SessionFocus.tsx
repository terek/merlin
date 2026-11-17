// A session open inside the Overview (`?open=<harness>:<id>`, docs/ui.md section 10b, "A session in place"): a
// sticky head (SessionHead: the session's own line, the paginator, and the graph's locator pinned under it) and
// under it the session's graph in the frame of the page. The list itself stays mounted behind it (Table), so
// closing puts it back as it was.

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useHarness } from '../../api/harnesses'
import { sessionQuery, useSession } from '../../api/queries'
import type { OverviewLane } from '../../api/types'
import { resumeCommand } from '../../lib/paths'
import { sessionTitle } from '../../lib/session'
import { isTyping, useShortcut } from '../../shell/useShortcut'
import { closedSearch, focusSearch, type Key, positionIn } from './focus'
import { folderText, laneDescription, laneHead } from './model'
import { SessionHead } from './SessionHead'
import { SessionView } from './SessionView'

/** What the head needs of the page. */
export interface HeadContext {
  /** Every session of the range (the list's rows are the ones the scope and the search leave). */
  lanes: readonly OverviewLane[]
  home: string | undefined
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
  ctx: HeadContext
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
  // the locator is drawn by the graph, into the head's slot
  const [locatorHost, setLocatorHost] = useState<HTMLElement | null>(null)
  return (
    <>
      <SessionHead
        harness={key.harness}
        title={title}
        desc={lane ? laneDescription(lane) : ''}
        folder={folderText(dir, ctx.home)}
        folderPath={dir || 'No folder'}
        command={command}
        usd={lane?.usd}
        at={at}
        prev={prev ? () => goTo(prev) : null}
        next={next ? () => goTo(next) : null}
        onClose={() => goTo(null)}
        locatorRef={setLocatorHost}
      />
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <SessionView
          // the session's own state (pin, zoom, frame) is the session's: a new one starts fresh
          key={`${open.harness}:${open.id}`}
          harness={open.harness}
          id={open.id}
          search={search}
          hash={hash}
          hrefFor={hrefFor}
          locatorHost={locatorHost}
        />
      </div>
    </>
  )
}
