// A session in the Overview's focus (docs/ui.md section 9): a session and everything forked or continued from it
// as one tree, the graph at its centre; a click pins a turn (or a piece of agent work) and opens it underneath.
// `SessionView` is what the Overview draws for `?open=<harness>:<id>`; the old address /s/:harness/:id redirects there.
// URL: #t<n> pins turn n, #a<agentId> opens that agent's work, #c<n> pins the turn of compaction n
// (search results and other pages link with these). The zoom is `sfrom`/`sto`. Also pin=<turn>, unit=<agentId>#<n>,
// cursor=<turn> for development and screenshots.
import { useQueries } from '@tanstack/react-query'
import { SearchX } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { get, isApiError } from '../../api/client'
import { queryKeys, useSession } from '../../api/queries'
import type { Candidate, SessionDetail, SessionKey } from '../../api/types'
import { useDocumentTitle } from '../../lib/hooks'
import { sessionTitle } from '../../lib/session'
import { isTyping } from '../../shell/useShortcut'
import { EmptyState, ErrorState, Id, ProjectName, QueryBoundary, RelTime, Skeleton, SkeletonRows } from '../../ui'
import { type Pin, SpendGraph, type UnitRef } from '../spend/SpendGraph'
import { parseHash, resolveTarget } from '../spend/session'
import { parseTime } from '../spend/timeline'
import { buildTree } from '../spend/tree'
import { TurnBox } from './TurnBox'

const num = (s: string | null) => (s !== null && s !== '' && Number.isFinite(Number(s)) ? Number(s) : null)
const same = (a: SessionKey, b: SessionKey) => a.harness === b.harness && a.id === b.id

/** What the view reads of the address: the Overview's query (`sfrom`, `sto`, and the development parameters) and the hash. */
interface Address {
  search: string
  hash: string
}

function Loaded({
  home,
  details,
  missing,
  address,
}: {
  home: SessionDetail
  details: SessionDetail[]
  missing: number
  address: Address
}) {
  const params = new URLSearchParams(address.search)
  const tree = useMemo(() => buildTree(details), [details])
  const homeIndex = Math.max(
    0,
    tree.branches.findIndex((b) => same(b.key, home.summary.key)),
  )
  const fromHash = resolveTarget(tree, homeIndex, parseHash(address.hash))
  const [unit, setUnit] = useState<UnitRef | null>(() => {
    if (fromHash) return fromHash.unit
    const want = params.get('unit')
    return want && tree.branches[homeIndex]?.model.units.some((u) => u.id === want)
      ? { branch: homeIndex, id: want }
      : null
  })
  const [pinned, setPinned] = useState<Pin | null>(() => {
    if (fromHash) return fromHash.pin
    const b = tree.branches[homeIndex]
    const p = num(params.get('pin'))
    if (b && p !== null && b.model.cols[p] && !b.model.cols[p].inherited) return { branch: homeIndex, col: p }
    const u = unit ? b?.model.units.find((x) => x.id === unit.id) : undefined
    return u ? { branch: homeIndex, col: u.launch } : null
  })
  const branch = pinned ? tree.branches[pinned.branch] : undefined
  const col = branch && pinned ? branch.model.cols[pinned.col] : undefined
  const unitOf = (r: UnitRef | null) =>
    r ? tree.branches[r.branch]?.model.units.find((u) => u.id === r.id) : undefined

  const pin = (p: Pin | null) => {
    setPinned(p)
    // a piece of agent work stays open on the turn that launched it and the ones its reports came in
    const u = unitOf(unit)
    if (!p || !unit || !u || p.branch !== unit.branch || (u.launch !== p.col && !u.reports.includes(p.col)))
      setUnit(null)
  }
  const selectUnit = (r: UnitRef | null) => {
    setUnit(r)
    const u = unitOf(r)
    if (r && u && !(pinned?.branch === r.branch && (pinned.col === u.launch || u.reports.includes(pinned.col))))
      setPinned({ branch: r.branch, col: u.launch })
  }

  // a sender of a message, or a sub-agent: its work, wherever in the tree it is
  const openAgent = (id: string) => {
    const t = resolveTarget(tree, homeIndex, { kind: 'agent', id })
    if (!t) return
    setPinned(t.pin)
    setUnit(t.unit)
  }

  // a link to a turn, a compaction or an agent (from search) opens it, here or on a later hash change
  const opened = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new hash opens a new target
  useEffect(() => {
    const t = resolveTarget(tree, homeIndex, parseHash(address.hash))
    if (!t) return
    setPinned(t.pin)
    setUnit(t.unit)
    requestAnimationFrame(() => opened.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }, [address.hash])

  // Esc takes the pin back before it closes the session: one Esc does one thing (the focus closes on an Esc
  // nobody has handled). Listened to in the capture phase, so that it is settled before anything else sees it.
  useEffect(() => {
    if (!pinned && !unit) return
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isTyping(e.target)) return
      e.preventDefault()
      setPinned(null)
      setUnit(null)
    }
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  }, [pinned, unit])

  const multi = tree.branches.length > 1

  return (
    <div className="space-y-4 p-4">
      {missing > 0 && (
        <p className="text-sec text-warn">
          {missing === 1 ? 'One session' : `${missing} sessions`} of this tree could not be loaded.
        </p>
      )}
      <SpendGraph
        tree={tree}
        home={homeIndex}
        current={home.summary.key}
        pinned={pinned}
        onPin={pin}
        selectedUnit={unit}
        onSelectUnit={selectUnit}
        initialCursor={num(params.get('cursor')) ?? undefined}
        initialWindow={{ lo: parseTime(params.get('sfrom')), hi: parseTime(params.get('sto')) }}
        keyInPanel
      />
      <div ref={opened} className="scroll-mt-4 space-y-4">
        {branch && col && pinned && (
          <TurnBox
            key={`${pinned.branch}/${col.index}`}
            model={branch.model}
            col={col}
            branchTitle={multi ? branch.title : undefined}
            unit={unit?.branch === pinned.branch ? branch.model.units.find((u) => u.id === unit.id) : undefined}
            onPin={(i) => pin(i === null ? null : { branch: pinned.branch, col: i })}
            onSelectUnit={(id) => (id === null ? setUnit(null) : selectUnit({ branch: pinned.branch, id }))}
            onOpenAgent={openAgent}
            onOpenTurn={(i) => {
              setUnit(null)
              setPinned({ branch: pinned.branch, col: i })
            }}
          />
        )}
      </div>
    </div>
  )
}

/** Loads every session of the family of `home`, with its messages. */
function Family({ home, address }: { home: SessionDetail; address: Address }) {
  const others = home.family.members.map((m) => m.key).filter((k) => !same(k, home.summary.key))
  const results = useQueries({
    queries: others.map((k) => ({
      queryKey: queryKeys.session(k.harness, k.id, true),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        get<SessionDetail>(
          `/api/sessions/${encodeURIComponent(k.harness)}/${encodeURIComponent(k.id)}`,
          { messages: 1 },
          signal,
        ),
    })),
  })
  if (results.some((r) => r.isPending)) return <PageSkeleton />
  const loaded = results.flatMap((r) => (r.data ? [r.data] : []))
  // in the family's own order: a parent before its children, siblings oldest first
  const details = home.family.members.flatMap((m) => {
    const d = same(m.key, home.summary.key) ? home : loaded.find((x) => same(x.summary.key, m.key))
    return d ? [d] : []
  })
  return (
    <Loaded
      key={`${home.summary.key.harness}/${home.summary.key.id}`}
      home={home}
      details={details.length ? details : [home]}
      missing={others.length - loaded.length}
      address={address}
    />
  )
}

function Candidates({ list, hrefFor }: { list: Candidate[]; hrefFor: (key: SessionKey) => string }) {
  return (
    <ul className="mx-auto mt-2 max-w-col divide-y divide-line rounded-card border border-line bg-surface">
      {list.map((c) => (
        <li key={c.key.id}>
          <Link to={hrefFor(c.key)} className="flex flex-col gap-0.5 px-3 py-2 hover:bg-surface-2 hover:no-underline">
            <span className="[overflow-wrap:anywhere]">{c.title || c.key.id}</span>
            <span className="flex flex-wrap items-center gap-x-2 text-sec text-muted">
              <ProjectName path={c.project} />
              <RelTime time={c.lastActivityAt} />
              <Id value={c.key.id} full className="text-faint" />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

function PageSkeleton() {
  return (
    <div className="space-y-4 p-4">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <SkeletonRows rows={4} height={72} />
    </div>
  )
}

export interface SessionViewProps {
  harness: string
  /** The session's id, or a unique prefix of it. */
  id: string
  /** The Overview's query (`sfrom`, `sto` and the development parameters are read from it) and the address's hash. */
  search: string
  hash: string
  /** Where a candidate of an ambiguous id leads: the Overview with it open. */
  hrefFor: (key: SessionKey) => string
}

/** The session the Overview has open: its graph, and the pinned turn under it. */
export function SessionView({ harness, id, search, hash, hrefFor }: SessionViewProps) {
  const query = useSession(harness, id, { messages: true })
  useDocumentTitle(query.data ? sessionTitle(query.data.summary) : undefined)

  const err = query.data ? undefined : query.error
  if (isApiError(err) && err.code === 'ambiguous_id') {
    return (
      <div className="p-6">
        <EmptyState title="Several sessions start with this id">Pick the one you meant.</EmptyState>
        <Candidates list={err.candidates} hrefFor={hrefFor} />
      </div>
    )
  }
  if (isApiError(err) && err.status === 404) {
    return (
      <div className="p-6">
        <EmptyState icon={<SearchX size={24} />} title="No such session">
          Merlin has no session with the id <span className="font-mono">{id}</span>. It may have been deleted before it
          was indexed, or the id is mistyped.
        </EmptyState>
      </div>
    )
  }
  if (err) return <ErrorState error={err} onRetry={() => void query.refetch()} />
  return (
    <QueryBoundary query={query} skeleton={<PageSkeleton />}>
      {(d) => <Family home={d} address={{ search, hash }} />}
    </QueryBoundary>
  )
}
