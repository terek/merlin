// The Cost page (docs/ui.md section 10): the Overview's scope read as money. The scope is the same URL
// (`range`, `from`, `to`, `by`, `in`, `q`) and the same two capsules in the top bar; the page shows what
// that scope cost: the total and how well it is backed, by day, by model, by kind and by place.

import { ChevronRight, Folder, FolderX, Search } from 'lucide-react'
import { type ReactNode, useEffect, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useCost, useOverview, useSearch } from '../../api/queries'
import type { CostRow, CostTable } from '../../api/types'
import { cn } from '../../lib/cn'
import { tallyLine, warmLine } from '../../lib/compaction'
import { backingLowerBound, backingSentence, lowerBoundNote, unknownNote } from '../../lib/cost'
import { formatCount, formatMoney, plural } from '../../lib/format'
import { useDocumentTitle, useNow } from '../../lib/hooks'
import { modelLabel } from '../../lib/models'
import { scopeSearch } from '../../lib/scope'
import {
  Bar,
  Card,
  DataTable,
  EmptyState,
  Money,
  QueryBoundary,
  SegmentedControl,
  Select,
  Skeleton,
  SkeletonRows,
} from '../../ui'
import type { Column } from '../../ui/layout'
import {
  type Beads,
  BYS,
  beadLabel,
  customLabel,
  customPhrase,
  customWindow,
  displayPath,
  firstSpendDay,
  formatCustom,
  inferHome,
  keepSelection,
  type PlaceNode,
  presetRange,
  sessionKey,
} from '../overview/model'
import { BY_LABEL, folderIcon, NONE_TITLE } from '../overview/placeUi'
import { ScopeSlot, useScope } from '../overview/ScopeSlot'
import { DayChart, Swatch, segmentLabel } from './DayChart'
import { migrateCostSearch, type PlaceRow, placeRows } from './lens'
import {
  type Bucket,
  bucketsFor,
  type modelTone,
  OVERHEAD,
  parseStack,
  type Stack,
  stackOf,
  topModels,
  type Window,
} from './model'

const TEN_MIN = 600_000

const RANGE_CAPTION = { '1d': 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days' } as const

export function CostPage() {
  useDocumentTitle('Cost')
  const scope = useScope()
  const { sp, set, select, range, custom, by, sel, q } = scope
  const [, setSp] = useSearchParams()
  const stack = parseStack(sp.get('stack'))
  const now = useNow(300_000)

  // an old address (project, 90d, all, the cuts) becomes the same scope in the Overview's terms
  const everyDay = useCost({ by: 'day' })
  const firstDay = everyDay.data ? (firstSpendDay(everyDay.data.rows) ?? null) : null
  const migrated = migrateCostSearch(sp, now, firstDay)
  useEffect(() => {
    if (migrated instanceof URLSearchParams) setSp(migrated, { replace: true })
  }, [migrated, setSp])

  // the scope's days, whole local days as on the Overview
  const days = custom ?? presetRange(range, now)
  const win: Window = { since: days.from, until: days.to }
  const term = q.trim()
  const scoped = {
    since: days.from,
    until: days.to,
    place: sel === null ? undefined : by,
    in: sel ?? undefined,
    q: term,
  }

  const head = useCost({ by: 'kind', ...scoped }, { enabled: migrated === null })
  const dayRows = useCost({ by: 'day', split: 'model', ...scoped }, { enabled: migrated === null })
  const byModel = useCost({ by: 'model', ...scoped }, { enabled: migrated === null })

  // the places and the home come from the Overview's lanes for the same days: the figures are its figures
  const to = Math.ceil(now.getTime() / TEN_MIN) * TEN_MIN
  const w = customWindow(days, to)
  const overview = useOverview(
    { from: new Date(w.fromMs).toISOString(), to: new Date(w.toMs).toISOString(), slot: '1d' },
    migrated === null,
  )
  const lanes = overview.data?.lanes
  const beads = overview.data?.beads
  const home = useMemo(() => inferHome(lanes?.flatMap((l) => (l.dir ? [l.dir] : [])) ?? []), [lanes])
  const search = useSearch(term)
  const hits = useMemo(
    () => (search.data ? new Set(search.data.hits.map((h) => sessionKey(h.session.harness, h.session.id))) : undefined),
    [search.data],
  )

  if (migrated !== null) return <Skeleton className="m-4 h-64" />

  const empty = head.data !== undefined && head.data.rows.length === 0 && head.data.total.totalUSD === 0
  const overhead = byModel.data?.rows.find((r) => r.key === OVERHEAD)?.totalUSD ?? 0
  const caption = custom ? `${customLabel(custom, now)}` : RANGE_CAPTION[range]
  const where = [sel !== null ? `in ${displayPath(sel, home, by)}` : '', term ? `matching “${term}”` : ''].filter(
    Boolean,
  )
  const overviewTo = `/${scopeSearch(sp)}`

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4">
      <ScopeSlot scope={scope} home={home} beads={beads} />
      {empty ? (
        <Card>
          <EmptyState title="Nothing was spent here">
            Nothing was spent {customPhrase(days, now)}
            {sel !== null && ` in ${displayPath(sel, home, by)}`}
            {term && ` matching “${term}”`}.
            {(sel !== null || term) && (
              <div className="mt-3">
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => {
                    set({ in: undefined, q: undefined })
                  }}
                >
                  Clear the selection
                </button>
              </div>
            )}
          </EmptyState>
        </Card>
      ) : (
        <>
          <Headline
            query={head}
            caption={where.length ? `${caption} · ${where.join(' · ')}` : caption}
            overheadUSD={overhead}
          />

          <Card
            title="By day"
            actions={
              <SegmentedControl
                label="Stack by"
                value={stack}
                onChange={(v) => set({ stack: v === 'model' ? undefined : v })}
                options={[
                  { value: 'model', label: 'By model' },
                  {
                    value: 'source',
                    label: 'Reported / attributed',
                    title:
                      "Stack by where the figure comes from (reported, recomputed, or the harness's own per-call figure)",
                  },
                  {
                    value: 'compaction',
                    label: 'Compactions',
                    title:
                      'The estimated cost of the calls that wrote compaction summaries, and what a cold cache added',
                  },
                ]}
              />
            }
          >
            <QueryBoundary query={dayRows} skeleton={<Skeleton className="h-56" />}>
              {(d) => (
                <ChartBody
                  rows={d.rows}
                  win={win}
                  stack={stack}
                  onPick={(b) => set({ range: undefined, ...formatCustom({ from: b.key, to: b.to }) })}
                />
              )}
            </QueryBoundary>
          </Card>

          <div className="grid grid-cols-[repeat(auto-fit,minmax(440px,1fr))] items-start gap-4">
            <Card title="By model" flush>
              <CutTable
                query={byModel}
                name="Model"
                label={(r) =>
                  r.key === OVERHEAD ? (
                    <span title="Spend the harness reported that no transcript message explains.">
                      (overhead)<sup className="ml-0.5 text-faint">1</sup>
                    </span>
                  ) : (
                    <span title={r.key}>{modelLabel(r.key)}</span>
                  )
                }
                footer={(d) =>
                  d.rows.some((r) => r.key === OVERHEAD) && (
                    <>
                      <sup>1</sup> (overhead) is spend the harness reported that no transcript message explains. It has
                      no model of its own.
                    </>
                  )
                }
              />
            </Card>
            <Card title="By kind" flush>
              <CutTable
                query={head}
                name="Kind"
                label={(r) => <span title={r.label}>{r.key === 'sdk' ? 'sdk (scripted runs with spend)' : r.key}</span>}
              />
            </Card>
            <Card
              title="By place"
              flush
              actions={
                <Select
                  label="Organise by"
                  value={by}
                  onChange={(v) =>
                    set({ by: v === 'dir' ? undefined : v, in: keepSelection(sel, lanes ?? [], v, beads) })
                  }
                  options={BYS.map((v) => ({ value: v, label: BY_LABEL[v] }))}
                  className="w-32"
                />
              }
            >
              <QueryBoundary
                query={overview}
                skeleton={<SkeletonRows rows={4} height={32} />}
                empty={<EmptyState title="No places in this range" />}
                isEmpty={(o) => o.lanes.length === 0}
              >
                {(o) => (
                  <PlaceTable
                    rows={placeRows(o.lanes, {
                      by,
                      sel,
                      term,
                      hits,
                      home,
                      beads: o.beads,
                      label: (n) => (by === 'bead' ? beadLabel(n.label, o.beads) : { text: n.label, closed: false }),
                    })}
                    by={by}
                    beads={o.beads}
                    onPick={(r) => select(r.path)}
                  />
                )}
              </QueryBoundary>
            </Card>
          </div>
          <p className="pt-1 text-sec text-muted">
            <Link to={overviewTo} className="inline-flex items-center gap-1">
              <Search size={12} aria-hidden /> The sessions behind these figures →
            </Link>
          </p>
        </>
      )}
    </div>
  )
}

function Headline({ query, caption, overheadUSD }: { query: CutQuery; caption: string; overheadUSD: number }) {
  return (
    <Card>
      <QueryBoundary query={query} skeleton={<Skeleton className="h-16" />}>
        {(d) => {
          const { totalUSD, reportedUSD, attributedUSD } = d.total
          const recordedUSD = d.total.recordedUSD ?? 0
          return (
            <div className="grid items-center gap-x-10 gap-y-3 grid-cols-[auto_1fr]">
              <div>
                <div className="text-sec text-muted">{caption}</div>
                <div className="text-page" data-testid="total">
                  <Money usd={totalUSD} lowerBound={backingLowerBound(d.backing)} />
                </div>
              </div>
              <div className="min-w-0 space-y-1.5">
                <Bar
                  height={8}
                  label="Reported versus attributed"
                  segments={[
                    { value: reportedUSD, tone: 'reported', title: 'Reported by the harness' },
                    { value: attributedUSD, tone: 'attributed', title: 'Attributed from token counts' },
                    { value: recordedUSD, tone: 'recorded', title: 'Recorded per call by the harness' },
                  ]}
                />
                <div className="flex flex-wrap gap-x-6 gap-y-0.5 text-sec">
                  <Source tone="reported" name="Reported" usd={reportedUSD} note="the harness's own figure" />
                  <Source tone="attributed" name="Attributed" usd={attributedUSD} note="recomputed from token counts" />
                  {recordedUSD > 0 && (
                    <Source
                      tone="recorded"
                      name="Recorded"
                      usd={recordedUSD}
                      note={recordedNote(recordedUSD, d.total.billedUSD ?? 0)}
                    />
                  )}
                </div>
                <div className="text-sec text-muted">{backingSentence(d.backing)}</div>
                {overheadUSD > 0.005 && (
                  <div className="text-sec text-muted" data-testid="overhead-line">
                    {formatMoney(overheadUSD)} of it is reported spend no message explains, so it is in no session’s
                    figure on the Overview.
                  </div>
                )}
                {(d.backing.unknown ?? 0) > 0 && (
                  <div className="text-sec text-muted" data-testid="unknown-line">
                    {unknownNote(d.backing.unknown ?? 0)}
                  </div>
                )}
                {d.total.compactions && d.total.compactions.calls > 0 && (
                  <div
                    className="text-sec text-muted"
                    data-testid="compaction-line"
                    title="The harness does not record the call that writes a compaction summary; this is estimated from the context size and the price table. Inside a reported figure it is part of the overhead; outside, it is in no figure at all. A cold call read its whole context again at full price."
                  >
                    Compaction calls, estimated: {tallyLine(d.total.compactions)}
                    {d.total.compactions.cold > 0 && (
                      <>
                        {' · '}
                        <span className="text-bad">{warmLine(d.total.compactions)}</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        }}
      </QueryBoundary>
    </Card>
  )
}

/** What the Recorded source is: the harness's own per-call figures, and how much of them the provider billed. */
function recordedNote(recordedUSD: number, billedUSD: number): string {
  const own = "the harness's own per-call figures"
  if (billedUSD <= 0) return `${own}, its price-catalog estimate`
  if (billedUSD >= recordedUSD - 1e-9) return `${own}, billed by the provider per call`
  return `${own}; ${formatMoney(billedUSD)} of it billed by the provider per call, the rest its catalog estimate`
}

function Source({
  tone,
  name,
  usd,
  note,
}: {
  tone: 'reported' | 'attributed' | 'recorded'
  name: string
  usd: number
  note: string
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="size-2 self-center rounded-badge" style={{ background: `var(--${tone})` }} />
      <span className="text-muted">{name}</span>
      <Money usd={usd} />
      <span className="text-faint">{note}</span>
    </span>
  )
}

function ChartBody({
  rows,
  win,
  stack,
  onPick,
}: {
  rows: CostRow[]
  win: Window
  stack: Stack
  onPick: (b: Bucket) => void
}) {
  const buckets = useMemo(() => bucketsFor(rows, win), [rows, win])
  const top = useMemo(() => topModels(buckets), [buckets])
  const legend = useMemo(() => legendOf(buckets, stack, top), [buckets, stack, top])
  const weekly = buckets[0]?.weekly
  if (buckets.length === 0) return <EmptyState title="No days in this range" />
  return (
    <div className="space-y-2">
      <DayChart buckets={buckets} stack={stack} top={top} onSelect={onPick} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sec text-muted">
        {legend.map((l) => (
          <span key={l.key} className="inline-flex items-center gap-1.5">
            <Swatch tone={l.tone} />
            {segmentLabel(l.key)}
          </span>
        ))}
        {stack === 'compaction' && legend.length > 0 && (
          <span className="text-bad">N over a bar: cold compactions</span>
        )}
        {weekly && <span className="ml-auto text-faint">One bar per week (Mon to Sun)</span>}
      </div>
      {stack === 'compaction' && <CompactionNote buckets={buckets} />}
    </div>
  )
}

/**
 * What the compaction view stands for. A compaction is one more call over the whole context; with a
 * warm cache that context is a cache read, after an idle gap longer than the cache lifetime it is
 * read again at full price. The figures are estimates and are kept out of the spend.
 */
function CompactionNote({ buckets }: { buckets: Bucket[] }) {
  let calls = 0
  let cold = 0
  let usd = 0
  let warm = 0
  for (const b of buckets) {
    const c = b.compactions
    if (!c) continue
    calls += c.calls
    cold += c.cold
    usd += c.usd
    warm += c.warmUSD
  }
  if (calls === 0) return <p className="text-sec text-muted">No compactions in this range.</p>
  return (
    <p className="max-w-[110ch] text-sec text-muted" data-testid="compaction-chart-note">
      {plural(calls, 'compaction')} cost ~{formatMoney(usd)}
      {cold > 0 ? (
        <>
          ; <span className="text-bad">{cold} of them ran on a cold cache</span>, which added ~{formatMoney(usd - warm)}{' '}
          over the ~{formatMoney(warm)} they would have cost warm.
        </>
      ) : (
        ', all on a warm cache.'
      )}{' '}
      A compaction sends the whole context once more to write the summary: warm, that is a cache read; after the main
      agent sat idle longer than the cache lifetime, it is read again at full price. Compacting before a long break, or
      right after coming back while the turn is still cached, is what keeps it cheap. Estimated from the context size:
      Claude Code does not record the call, so these figures are not in the spend above (Codex records it, and its
      compaction calls are in the spend like any other).
    </p>
  )
}

function legendOf(buckets: Bucket[], stack: Stack, top: string[]) {
  const seen = new Map<string, ReturnType<typeof modelTone>>()
  for (const b of buckets) for (const s of stackOf(b, stack, top)) seen.set(s.key, s.tone)
  const order =
    stack === 'source'
      ? ['reported', 'attributed', 'recorded']
      : stack === 'compaction'
        ? ['compaction-warm', 'compaction-cold']
        : [...top, 'other', OVERHEAD]
  return order.filter((k) => seen.has(k)).map((key) => ({ key, tone: seen.get(key) as ReturnType<typeof modelTone> }))
}

type CutQuery = Parameters<typeof QueryBoundary<CostTable>>[0]['query']

function CutTable({
  query,
  name,
  label,
  onPick,
  selected,
  footer,
}: {
  query: CutQuery
  name: string
  label: (r: CostRow) => ReactNode
  onPick?: (r: CostRow) => void
  selected?: string
  footer?: (d: CostTable) => ReactNode
}) {
  return (
    <QueryBoundary
      query={query}
      skeleton={<SkeletonRows rows={4} height={32} />}
      empty={<EmptyState title="Nothing in this range" />}
      isEmpty={(d) => d.rows.length === 0}
    >
      {(d) => {
        const columns: Column<CostRow>[] = [
          {
            key: 'name',
            header: name,
            sortValue: (r) => r.key.toLowerCase(),
            cell: (r) => (
              <div className="min-w-0 py-1" title={`${formatCount(r.sessions)} sessions`}>
                <div className="truncate">{label(r)}</div>
                <Bar
                  height={3}
                  className="mt-1"
                  label={`${share(r.totalUSD, d.total.totalUSD)} of the total`}
                  segments={[{ value: r.totalUSD, tone: r.key === OVERHEAD ? 'overhead' : 'accent' }]}
                  total={d.total.totalUSD}
                />
              </div>
            ),
          },
          {
            key: 'total',
            header: 'Total',
            align: 'right',
            width: '84px',
            sortValue: (r) => r.totalUSD,
            cell: (r) => <Money usd={r.totalUSD} lowerBound={lowerBoundNote(0, 0, r.unrecordedAgents)} />,
          },
          {
            key: 'reported',
            header: 'Reported',
            align: 'right',
            width: '84px',
            sortValue: (r) => r.reportedUSD,
            cell: (r) => <Money usd={r.reportedUSD} dim />,
          },
          {
            key: 'attributed',
            header: 'Attributed',
            align: 'right',
            width: '92px',
            sortValue: (r) => r.attributedUSD,
            cell: (r) => <Money usd={r.attributedUSD} dim />,
          },
          // Pi's own per-call figures: a column only when the table has some, so Claude Code and
          // Codex users see the same three.
          ...((d.total.recordedUSD ?? 0) > 0
            ? [
                {
                  key: 'recorded',
                  header: 'Recorded',
                  align: 'right' as const,
                  width: '92px',
                  sortValue: (r: CostRow) => r.recordedUSD ?? 0,
                  cell: (r: CostRow) => (
                    <Money usd={r.recordedUSD ?? 0} dim title={recordedNote(r.recordedUSD ?? 0, r.billedUSD ?? 0)} />
                  ),
                },
              ]
            : []),
        ]
        const note = footer?.(d)
        return (
          <DataTable
            columns={columns}
            rows={d.rows}
            rowKey={(r) => r.key}
            defaultSort={{ key: 'total', dir: 'desc' }}
            onRowClick={onPick}
            selectedKey={selected}
            stickyTop={0}
            className="table-fixed"
            footer={note || undefined}
          />
        )
      }}
    </QueryBoundary>
  )
}

function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%'
}

/** The places of the scope, ranked: the children of the selection, each over everything under it. */
function PlaceTable({
  rows,
  by,
  beads,
  onPick,
}: {
  rows: { rows: PlaceRow[]; total: number }
  by: keyof typeof BY_LABEL
  beads?: Beads
  onPick: (r: PlaceRow) => void
}) {
  const columns: Column<PlaceRow>[] = [
    {
      key: 'name',
      header: BY_LABEL[by],
      cell: (r) => {
        const Icon = r.none ? FolderX : r.node ? folderIcon(r.node as PlaceNode, by, false, beads) : Folder
        return (
          <div className="min-w-0 py-1" title={r.none ? NONE_TITLE[by] : r.title}>
            <div className={cn('flex items-center gap-1.5 truncate', r.closed && 'text-muted')}>
              <Icon size={14} aria-hidden className="shrink-0 text-muted" />
              <span className="truncate">{r.text}</span>
              {r.sub && <span className="whitespace-nowrap text-faint text-meta">{r.sub}</span>}
              {r.drill && <ChevronRight size={12} aria-hidden className="ml-auto shrink-0 text-faint" />}
            </div>
            <Bar
              height={3}
              className="mt-1"
              label={`${share(r.usd, rows.total)} of the places shown`}
              segments={[{ value: r.usd, tone: 'accent' }]}
              total={rows.total}
            />
          </div>
        )
      },
    },
    {
      key: 'sessions',
      header: 'Sessions',
      align: 'right',
      width: '84px',
      cell: (r) => <span className="text-muted">{formatCount(r.count)}</span>,
    },
    {
      key: 'total',
      header: 'Spend',
      align: 'right',
      width: '92px',
      cell: (r) => <Money usd={r.usd} />,
    },
  ]
  return (
    <DataTable
      columns={columns}
      rows={rows.rows}
      rowKey={(r) => r.id}
      onRowClick={(r) => {
        if (!r.id.endsWith('#here')) onPick(r)
      }}
      stickyTop={0}
      className="table-fixed"
      footer="These count spend in messages, as the Overview does: reported spend no message explains, and scripted runs, are in none of them."
    />
  )
}
