// A session in the Overview's focus (docs/ui.md section 9): a session and everything forked or continued from it
// as one tree, the graph at its centre; a click selects a turn, a piece of agent work or a background job and opens it underneath.
// `SessionView` is what the Overview draws for `?open=<harness>:<id>`; the old address /s/:harness/:id redirects there.
// URL: #t<n> selects turn n, #a<agentId> opens that agent's work, #c<n> selects the turn of compaction n
// (search results and other pages link with these). The zoom is `sfrom`/`sto`. Also pin=<turn> (selects the turn), unit=<agentId>#<n>,
// cursor=<turn> for development and screenshots.
import { useQueries } from '@tanstack/react-query'
import { SearchX } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { get, isApiError } from '../../api/client'
import { queryKeys, useLimits, useSession } from '../../api/queries'
import type { Candidate, SessionDetail, SessionKey } from '../../api/types'
import { useDocumentTitle } from '../../lib/hooks'
import { sessionTitle } from '../../lib/session'
import { isTyping } from '../../shell/useShortcut'
import { EmptyState, ErrorState, Id, ProjectName, QueryBoundary, RelTime, Skeleton, SkeletonRows } from '../../ui'
import { type Selection, SpendGraph } from '../spend/SpendGraph'
import { parseHash, resolveTarget } from '../spend/session'
import { parseTime, type TimeRange } from '../spend/timeline'
import { buildTree } from '../spend/tree'
import { sessionKey } from './model'
import { TurnBox } from './TurnBox'
import { refusalsBySession, sessionLockouts } from './windows'

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
  locatorHost,
  scope,
}: {
  home: SessionDetail
  details: SessionDetail[]
  missing: number
  address: Address
  locatorHost?: HTMLElement | null
  scope?: TimeRange
}) {
  const params = new URLSearchParams(address.search)
  const tree = useMemo(() => buildTree(details), [details])
  const homeIndex = Math.max(
    0,
    tree.branches.findIndex((b) => same(b.key, home.summary.key)),
  )
  const fromHash = resolveTarget(tree, homeIndex, parseHash(address.hash))
  // the one selection: a turn, a piece of agent work or a background job; the box under the graph shows it
  const [selected, setSelected] = useState<Selection | null>(() => {
    if (fromHash) return fromHash
    const b = tree.branches[homeIndex]
    const want = params.get('unit')
    if (want && b?.model.units.some((u) => u.id === want)) return { kind: 'unit', branch: homeIndex, id: want }
    const p = num(params.get('pin'))
    if (b && p !== null && b.model.cols[p] && !b.model.cols[p].inherited)
      return { kind: 'turn', branch: homeIndex, col: p }
    return null
  })
  const branch = selected ? tree.branches[selected.branch] : undefined

  // a sender of a message, or a sub-agent: its work, wherever in the tree it is
  const openAgent = (id: string) => {
    const t = resolveTarget(tree, homeIndex, { kind: 'agent', id })
    if (t) setSelected(t)
  }

  // a link to a turn, a compaction or an agent (from search) opens it, here or on a later hash change
  const opened = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new hash opens a new target
  useEffect(() => {
    const t = resolveTarget(tree, homeIndex, parseHash(address.hash))
    if (!t) return
    setSelected(t)
    requestAnimationFrame(() => opened.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }, [address.hash])

  // Esc takes the selection back before it closes the session: one Esc does one thing (the focus closes on an Esc
  // nobody has handled). Listened to in the capture phase, so that it is settled before anything else sees it.
  useEffect(() => {
    if (!selected) return
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isTyping(e.target)) return
      e.preventDefault()
      setSelected(null)
    }
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  }, [selected])

  const multi = tree.branches.length > 1
  // the harness's limit lockouts (the plot clips them to its axis)
  const limits = useLimits()
  const lockouts = useMemo(() => sessionLockouts(limits.data, home.summary.key), [limits.data, home.summary.key])

  const refusals = useMemo(
    () => refusalsBySession(limits.data?.refusals ?? []).get(sessionKey(home.summary.key.harness, home.summary.key.id)),
    [limits.data, home.summary.key.harness, home.summary.key.id],
  )

  return (
    <div>
      {missing > 0 && (
        <p className="border-line border-b px-4 py-2 text-sec text-warn">
          {missing === 1 ? 'One session' : `${missing} sessions`} of this tree could not be loaded.
        </p>
      )}
      <SpendGraph
        tree={tree}
        home={homeIndex}
        current={home.summary.key}
        selected={selected}
        onSelect={setSelected}
        initialCursor={num(params.get('cursor')) ?? undefined}
        initialWindow={{ lo: parseTime(params.get('sfrom')), hi: parseTime(params.get('sto')) }}
        keyInPanel
        lockouts={lockouts}
        refusals={refusals}
        locatorHost={locatorHost}
        scope={scope}
      />
      <div ref={opened} className="scroll-mt-12">
        {branch && selected && (
          <TurnBox
            key={`${selected.kind}/${selected.branch}/${'col' in selected ? selected.col : selected.id}`}
            branch={branch}
            branchTitle={multi ? branch.title : undefined}
            selection={selected}
            onSelect={setSelected}
            onOpenAgent={openAgent}
          />
        )}
      </div>
    </div>
  )
}

/** Loads every session of the family of `home`, with its messages. */
function Family({
  home,
  address,
  locatorHost,
  scope,
}: {
  home: SessionDetail
  address: Address
  locatorHost?: HTMLElement | null
  scope?: TimeRange
}) {
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
      locatorHost={locatorHost}
      scope={scope}
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
    <div className="space-y-4 px-4 py-3">
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
  /** Where the graph's locator strip goes: the head's pinned slot (null until it mounts). Undefined: in the page. */
  locatorHost?: HTMLElement | null
  /** The Overview list's time range: the session opens on its part in it (`sfrom`/`sto` win). */
  scope?: TimeRange
}

/** The session the Overview has open: its graph, and what is selected under it. */
export function SessionView({ harness, id, search, hash, hrefFor, locatorHost, scope }: SessionViewProps) {
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
      {(d) => <Family home={d} address={{ search, hash }} locatorHost={locatorHost} scope={scope} />}
    </QueryBoundary>
  )
}
