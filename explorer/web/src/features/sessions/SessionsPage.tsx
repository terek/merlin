// The Sessions page (docs/ui.md section 8): project rail, filters kept in the URL, the day-grouped
// list with families and scripted lines, search, keyboard navigation. Live updates arrive through
// the shared cache layer and re-render the rows in place.

import { FolderOpen, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useSearch, useSessions } from '../../api/queries'
import type { SessionSummary } from '../../api/types'
import { plural } from '../../lib/format'
import { useDebounced, useDocumentTitle, useInView } from '../../lib/hooks'
import { sessionPath, shortProject } from '../../lib/paths'
import { keyString, sessionTitle } from '../../lib/session'
import { dayLabelOf } from '../../lib/time'
import { useShortcut } from '../../shell/useShortcut'
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Money,
  QueryBoundary,
  SearchInput,
  SegmentedControl,
  Select,
  SkeletonRows,
  Spinner,
} from '../../ui'
import {
  apiFilters,
  buildDayGroups,
  type DayGroup,
  groupHits,
  hasFilters,
  type KindFilter,
  moveSelection,
  type PageFilters,
  readFilters,
  type SinceFilter,
  type StateFilter,
  showsScripted,
  writeFilters,
} from './model'
import { ProjectRail } from './ProjectRail'
import { hitNavItems, SearchResults } from './SearchResults'
import { SessionRow } from './SessionRow'

const RAIL_KEY = 'explorer-sessions-rail'

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === 'collapsed'
  } catch {
    return false
  }
}

function saveCollapsed(v: boolean) {
  try {
    localStorage.setItem(RAIL_KEY, v ? 'collapsed' : 'open')
  } catch {
    // storage unavailable: the rail simply opens again next time
  }
}

const STATE_OPTIONS: { value: StateFilter; label: string; title: string }[] = [
  { value: '', label: 'All', title: 'Every session' },
  { value: 'running', label: 'Running', title: 'Busy or waiting for input' },
  { value: 'recent', label: 'Recent', title: 'Not running, active in the last 10 minutes' },
]

const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: '', label: 'All kinds' },
  { value: 'interactive', label: 'Interactive' },
  { value: 'background', label: 'Background' },
]

const SINCE_OPTIONS: { value: SinceFilter; label: string }[] = [
  { value: '', label: 'All time' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
]

export function SessionsPage() {
  useDocumentTitle('Sessions')
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const filters = readFilters(params)
  const setFilters = (patch: Partial<PageFilters>, replace = false) =>
    setParams((p) => writeFilters(p, patch), { replace })

  // ---- search box: typing is local, the URL follows after 200 ms ----
  const [draft, setDraft] = useState(filters.q)
  const debounced = useDebounced(draft, 200)
  const written = useRef(filters.q)
  // biome-ignore lint/correctness/useExhaustiveDependencies: write only when the debounced text changes
  useEffect(() => {
    if (debounced !== written.current) {
      written.current = debounced
      setFilters({ q: debounced }, true)
    }
  }, [debounced])
  useEffect(() => {
    // back / forward changed `q`: the box follows
    if (filters.q !== written.current) {
      written.current = filters.q
      setDraft(filters.q)
    }
  }, [filters.q])
  const inputRef = useRef<HTMLInputElement>(null)

  const term = filters.q.trim()
  const searching = term.length >= 2

  // ---- data ----
  const { project, state, kind, since } = filters
  const api = useMemo(() => apiFilters({ project, state, kind, since, q: '' }), [project, state, kind, since])
  const { state: _state, ...searchFilters } = api
  const sessions = useSessions(api)
  const search = useSearch(term, searchFilters)
  const [collapsed, setCollapsed] = useState(loadCollapsed)

  const loaded: SessionSummary[] = useMemo(() => sessions.data?.pages.flatMap((p) => p.sessions) ?? [], [sessions.data])
  const more = sessions.hasNextPage
  const scriptedOn = showsScripted({ project, state, kind, since, q: '' })
  const scripted = sessions.data?.pages[0]?.scripted
  const groups = useMemo(
    () => buildDayGroups(loaded, scriptedOn ? (scripted ?? []) : [], Boolean(more)),
    [loaded, scripted, scriptedOn, more],
  )
  const titles = useMemo(() => new Map(loaded.map((s) => [keyString(s.key), sessionTitle(s)])), [loaded])

  // ---- keyboard: j / k move the selection, Enter opens it, / searches, Esc clears ----
  const [selected, setSelected] = useState<string | null>(null)
  const scrollToSelected = useRef(false)
  const nav = useMemo(() => {
    if (searching) return search.data ? hitNavItems(search.data) : []
    return groups.flatMap((g) =>
      g.rows.map((r) => ({ id: keyString(r.session.key), href: sessionPath(r.session.key) })),
    )
  }, [searching, search.data, groups])
  const move = (delta: 1 | -1) => {
    scrollToSelected.current = true
    setSelected((cur) =>
      moveSelection(
        nav.map((n) => n.id),
        cur,
        delta,
      ),
    )
  }
  useShortcut('j', () => move(1))
  useShortcut('k', () => move(-1))
  useShortcut(
    'Enter',
    (e) => {
      // a focused link or button handles Enter itself
      if (e.target instanceof HTMLElement && e.target.closest('a,button')) return
      const item = nav.find((n) => n.id === selected)
      if (item) navigate(item.href)
    },
    { preventDefault: false },
  )
  useShortcut('/', () => {
    inputRef.current?.focus()
    inputRef.current?.select()
  })
  useShortcut('Escape', () => {
    if (filters.q) {
      setDraft('')
      setFilters({ q: '' }, true)
      written.current = ''
    } else setSelected(null)
  })
  useEffect(() => {
    if (!scrollToSelected.current || selected === null) return
    scrollToSelected.current = false
    document.querySelector(`[data-nav-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const clearFilters = () => setFilters({ project: '', state: '', kind: '', since: '' })

  return (
    <div className="flex items-start">
      <ProjectRail
        selected={filters.project}
        onSelect={(project) => setFilters({ project })}
        collapsed={collapsed}
        onToggle={() => {
          saveCollapsed(!collapsed)
          setCollapsed(!collapsed)
        }}
      />
      <div className="min-w-0 flex-1">
        <div className="@container sticky top-11 z-10 flex h-11 items-center gap-2 border-b border-line bg-bg px-3">
          <SearchInput
            value={draft}
            onChange={setDraft}
            inputRef={inputRef}
            hint="/"
            placeholder="Search sessions…"
            label="Search sessions"
            className="min-w-40 max-w-md flex-1"
          />
          <span
            title={searching ? 'Search does not filter by state' : undefined}
            className={searching ? 'opacity-50' : ''}
          >
            <SegmentedControl
              label="State"
              value={filters.state}
              onChange={(state) => setFilters({ state })}
              options={STATE_OPTIONS}
            />
          </span>
          <Select label="Kind" value={filters.kind} onChange={(kind) => setFilters({ kind })} options={KIND_OPTIONS} />
          <Select
            label="Since"
            value={filters.since}
            onChange={(since) => setFilters({ since })}
            options={SINCE_OPTIONS}
          />
          {filters.project && collapsed && (
            <Badge tone="accent" className="max-w-48 shrink gap-1 py-px" title={filters.project}>
              <span className="truncate">{shortProject(filters.project)}</span>
              <button
                type="button"
                aria-label="Clear the project filter"
                onClick={() => setFilters({ project: '' })}
                className="inline-flex shrink-0 opacity-70 hover:opacity-100"
              >
                <X size={11} />
              </button>
            </Badge>
          )}
          <span className="ml-auto hidden shrink-0 whitespace-nowrap text-sec text-muted @[900px]:block">
            {searching
              ? search.data &&
                `${plural(search.data.hits.length, 'hit')} in ${plural(groupHits(search.data.hits).length, 'session')}`
              : sessions.data && plural(sessions.data.pages[0].total, 'session')}
          </span>
        </div>

        {searching ? (
          <div className={`bg-surface ${search.isPlaceholderData ? 'opacity-60' : ''}`}>
            <QueryBoundary
              query={search}
              skeleton={<SkeletonRows rows={6} height={44} />}
              isEmpty={(d) => d.hits.length === 0}
              empty={
                <EmptyState icon={<Search size={20} />} title={`No sessions match “${term}”`}>
                  Every word must occur in one prompt, answer, summary or title.
                  {hasFilters(filters) && ' The filters on this page narrow the search too.'}
                </EmptyState>
              }
            >
              {(d) => <SearchResults result={d} query={term} selectedId={selected} />}
            </QueryBoundary>
          </div>
        ) : (
          <ListView
            query={sessions}
            groups={groups}
            titles={titles}
            filters={filters}
            selected={selected}
            onClear={clearFilters}
          />
        )}
      </div>
    </div>
  )
}

function ListView({
  query,
  groups,
  titles,
  filters,
  selected,
  onClear,
}: {
  query: ReturnType<typeof useSessions>
  groups: DayGroup[]
  titles: Map<string, string>
  filters: PageFilters
  selected: string | null
  onClear: () => void
}) {
  const filtered = hasFilters(filters)
  return (
    <div className={query.isPlaceholderData ? 'opacity-60' : ''}>
      <QueryBoundary
        query={query}
        skeleton={<SkeletonRows rows={10} height={52} />}
        isEmpty={() => groups.length === 0}
        empty={
          filtered ? (
            <EmptyState
              icon={<FolderOpen size={20} />}
              title="No sessions match these filters"
              action={<Button onClick={onClear}>Clear filters</Button>}
            >
              Widen the time range or pick another project or state.
            </EmptyState>
          ) : (
            <EmptyState icon={<FolderOpen size={20} />} title="No sessions yet">
              Explorer lists the sessions it finds under ~/.claude. Start Claude Code in a project and the first one
              shows up here within a few seconds.
            </EmptyState>
          )
        }
      >
        {() => (
          <>
            <div className="bg-surface">
              {groups.map((g) => (
                <Group
                  key={g.day || 'none'}
                  group={g}
                  titles={titles}
                  hideProject={Boolean(filters.project)}
                  selected={selected}
                />
              ))}
            </div>
            <Footer query={query} count={groups.reduce((n, g) => n + g.rows.length, 0)} />
          </>
        )}
      </QueryBoundary>
    </div>
  )
}

function Group({
  group,
  titles,
  hideProject,
  selected,
}: {
  group: DayGroup
  titles: Map<string, string>
  hideProject: boolean
  selected: string | null
}) {
  return (
    <section>
      <header className="sticky top-[88px] z-[5] flex items-baseline gap-2 border-b border-line bg-bg px-3 py-1">
        <h3 className="text-sec font-medium">{group.day ? dayLabelOf(group.day) : 'No activity time'}</h3>
        {group.rows.length > 0 && <span className="text-meta text-faint">{plural(group.rows.length, 'session')}</span>}
        <span className="ml-auto flex items-baseline gap-0.5 text-sec">
          <Money usd={group.totalUSD} />
          {group.incomplete && (
            <span className="text-faint" title="More sessions of this day may follow; the sum grows as they load">
              +
            </span>
          )}
        </span>
      </header>
      {group.rows.map((row) => {
        const parent = row.session.lineage.parent
        return (
          <SessionRow
            key={keyString(row.session.key)}
            row={row}
            selected={selected === keyString(row.session.key)}
            hideProject={hideProject}
            parentTitle={parent ? titles.get(keyString(parent)) : undefined}
          />
        )
      })}
      {group.scripted.map((l) => (
        <div
          key={l.project}
          className="flex items-baseline gap-2 border-b border-line px-3 py-1 pl-9 text-sec text-faint"
          title="Scripted runs (claude -p, SDK) are summed, not listed"
        >
          <span className="min-w-0 truncate">
            {plural(l.count, 'scripted run')} · {shortProject(l.project)}
          </span>
          <Money usd={l.totalUSD} dim className="ml-auto" />
        </div>
      ))}
    </section>
  )
}

/** The end of the list: loads the next page when it scrolls into view. */
function Footer({ query, count }: { query: ReturnType<typeof useSessions>; count: number }) {
  const [ref, inView] = useInView({ rootMargin: '600px' })
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isFetchNextPageError } = query
  // biome-ignore lint/correctness/useExhaustiveDependencies: `count` re-runs this after each page, while the end is still in view
  useEffect(() => {
    if (inView && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage()
  }, [inView, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, count])
  return (
    <div ref={ref} className="flex min-h-16 items-center justify-center px-3 py-4 text-sec text-muted">
      {isFetchNextPageError ? (
        <ErrorState
          error={query.error}
          title="Could not load more"
          onRetry={() => void fetchNextPage()}
          className="py-2"
        />
      ) : isFetchingNextPage || hasNextPage ? (
        <Spinner />
      ) : (
        <span className="text-faint">That is all: {plural(count, 'session')}</span>
      )}
    </div>
  )
}
