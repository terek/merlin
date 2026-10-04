// The Session page (/s/:harness/:id): a session and everything forked or continued from it as one
// tree, built around spend. The graph is the centre; a click pins a turn (or a piece of agent
// work) and opens underneath the decision it belongs to and the turn itself, above the ranked
// decisions. The header, the resume command and the family list come first and last.
// URL: #t<n> pins turn n, #a<agentId> opens that agent's work, #c<n> pins the turn of compaction n
// (search results and other pages link with these). Also ?pin=<turn>, ?unit=<agentId>#<n>,
// ?split=class and ?cursor=<turn> for development and screenshots.
import { useQueries } from '@tanstack/react-query'
import { SearchX } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { get, isApiError } from '../../api/client'
import { queryKeys, useSession } from '../../api/queries'
import type { Candidate, SessionDetail, SessionKey } from '../../api/types'
import { useDocumentTitle } from '../../lib/hooks'
import { sessionPath } from '../../lib/paths'
import { sessionTitle } from '../../lib/session'
import { EmptyState, ErrorState, Id, ProjectName, QueryBoundary, RelTime, Skeleton, SkeletonRows } from '../../ui'
import { Banners, Diagnostics, FamilyStrip, ResumeBox, SessionHeader } from './Header'
import { type Pin, SpendGraph, type UnitRef } from './SpendGraph'
import { parseHash, resolveTarget } from './session'
import { DecisionPanel, TopDecisions, TurnInspector } from './TurnInspector'
import { buildTree } from './tree'

const num = (s: string | null) => (s !== null && s !== '' && Number.isFinite(Number(s)) ? Number(s) : null)
const same = (a: SessionKey, b: SessionKey) => a.harness === b.harness && a.id === b.id

function Loaded({ home, details, missing }: { home: SessionDetail; details: SessionDetail[]; missing: number }) {
  const loc = useLocation()
  const params = new URLSearchParams(loc.search)
  const tree = useMemo(() => buildTree(details), [details])
  const homeIndex = Math.max(
    0,
    tree.branches.findIndex((b) => same(b.key, home.summary.key)),
  )
  const fromHash = resolveTarget(tree, homeIndex, parseHash(loc.hash))
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
    // a piece of agent work stays open on the turn that launched it and the one its report came in
    const u = unitOf(unit)
    if (!p || !unit || !u || p.branch !== unit.branch || (u.launch !== p.col && u.ret !== p.col)) setUnit(null)
  }
  const selectUnit = (r: UnitRef | null) => {
    setUnit(r)
    const u = unitOf(r)
    if (r && u && !(pinned?.branch === r.branch && (pinned.col === u.launch || pinned.col === u.ret)))
      setPinned({ branch: r.branch, col: u.launch })
  }

  // a decision picked from the list at the bottom of the page is shown in the graph at the top
  const graph = useRef<HTMLDivElement>(null)
  const pinFromList = (p: Pin) => {
    pin(p)
    graph.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // a link to a turn, a compaction or an agent (from search) opens it, here or on a later hash change
  const opened = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new hash opens a new target
  useEffect(() => {
    const t = resolveTarget(tree, homeIndex, parseHash(loc.hash))
    if (!t) return
    setPinned(t.pin)
    setUnit(t.unit)
    requestAnimationFrame(() => opened.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }, [loc.hash])

  const multi = tree.branches.length > 1
  const sourceGone = home.summary.sourceMissing || home.digest.sourceMissing

  return (
    <div className="mx-auto max-w-[1500px] space-y-4 p-6">
      <Banners detail={home} />
      <SessionHeader
        detail={home}
        tree={{
          sessions: tree.branches.length,
          bestUSD: details.reduce((n, d) => n + d.cost.bestUSD, 0),
          messagesUSD: tree.total,
        }}
      />
      {missing > 0 && (
        <p className="text-sec text-warn">
          {missing === 1 ? 'One session' : `${missing} sessions`} of this tree could not be loaded.
        </p>
      )}
      {!sourceGone && <ResumeBox detail={home} />}
      <div ref={graph} className="scroll-mt-4">
        <SpendGraph
          tree={tree}
          home={homeIndex}
          pinned={pinned}
          onPin={pin}
          selectedUnit={unit}
          onSelectUnit={selectUnit}
          initialSplit={params.get('split') === 'class' ? 'class' : 'kind'}
          initialCursor={num(params.get('cursor')) ?? undefined}
        />
      </div>
      <div ref={opened} className="scroll-mt-4 space-y-4">
        {branch && col && pinned && !col.inherited && (
          <DecisionPanel
            key={`${pinned.branch}/d${col.decision}`}
            model={branch.model}
            decision={branch.model.decisions[col.decision]}
            branchTitle={multi ? branch.title : undefined}
            pinnedCol={col.index}
            selectedUnitId={unit?.branch === pinned.branch ? unit.id : null}
            onPin={(i) => pin({ branch: pinned.branch, col: i })}
            onSelectUnit={(id) => selectUnit({ branch: pinned.branch, id })}
          />
        )}
        {branch && col && pinned && (
          <TurnInspector
            key={`${pinned.branch}/${col.index}`}
            model={branch.model}
            col={col}
            branchTitle={multi ? branch.title : undefined}
            selectedUnitId={unit?.branch === pinned.branch ? unit.id : null}
            onPin={(i) => pin(i === null ? null : { branch: pinned.branch, col: i })}
            onSelectUnit={(id) => selectUnit(id === null ? null : { branch: pinned.branch, id })}
          />
        )}
      </div>
      <TopDecisions tree={tree} pinned={pinned} onPin={pinFromList} />
      <FamilyStrip detail={home} />
      <Diagnostics detail={home} />
    </div>
  )
}

/** Loads every session of the family of `home`, with its messages. */
function Family({ home }: { home: SessionDetail }) {
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
    />
  )
}

function Candidates({ list }: { list: Candidate[] }) {
  return (
    <ul className="mx-auto mt-2 max-w-col divide-y divide-line rounded-card border border-line bg-surface">
      {list.map((c) => (
        <li key={c.key.id}>
          <Link
            to={sessionPath(c.key)}
            className="flex flex-col gap-0.5 px-3 py-2 hover:bg-surface-2 hover:no-underline"
          >
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
    <div className="mx-auto max-w-[1500px] space-y-4 p-6">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <SkeletonRows rows={4} height={72} />
    </div>
  )
}

export function SessionPage() {
  const { harness = '', id = '' } = useParams()
  const query = useSession(harness, id, { messages: true })
  useDocumentTitle(query.data ? sessionTitle(query.data.summary) : undefined)

  const err = query.data ? undefined : query.error
  if (isApiError(err) && err.code === 'ambiguous_id') {
    return (
      <div className="p-6">
        <EmptyState title="Several sessions start with this id">Pick the one you meant.</EmptyState>
        <Candidates list={err.candidates} />
      </div>
    )
  }
  if (isApiError(err) && err.status === 404) {
    return (
      <div className="p-6">
        <EmptyState icon={<SearchX size={24} />} title="No such session" action={<Link to="/">Back to Sessions</Link>}>
          Merlin has no session with the id <span className="font-mono">{id}</span>. It may have been deleted before it
          was indexed, or the id is mistyped.
        </EmptyState>
      </div>
    )
  }
  if (err) return <ErrorState error={err} onRetry={() => void query.refetch()} />
  return (
    <QueryBoundary query={query} skeleton={<PageSkeleton />}>
      {(d) => <Family home={d} />}
    </QueryBoundary>
  )
}
