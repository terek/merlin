// The Cost page (docs/ui.md section 10): the Overview's scope read as money, in the Overview's frame: its sidebar
// (the places, where the selection lives), then one pane edge to edge. The scope is the Overview's URL (`range`,
// `from`, `to`, `by`, `in`; Cost has no search) and the range capsule in the top bar.

import { Search } from 'lucide-react'
import { type ReactNode, useEffect, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useCost, useOverview } from '../../api/queries'
import type { CostRow, CostTable } from '../../api/types'
import { cn } from '../../lib/cn'
import { backingLowerBound, backingSentence, lowerBoundNote, unknownNote } from '../../lib/cost'
import { formatCount, formatMoney, plural } from '../../lib/format'
import { useDocumentTitle, useNow } from '../../lib/hooks'
import { modelLabel } from '../../lib/models'
import { scopeSearch } from '../../lib/scope'
import { EmptyState, Money, QueryBoundary, SegmentedControl, Skeleton, SkeletonRows } from '../../ui'
import {
  buildPlaceTree,
  customLabel,
  customPhrase,
  customWindow,
  displayPath,
  firstSpendDay,
  formatCustom,
  inferHome,
  keepSelection,
  placeItems,
  presetRange,
  selectLanes,
  totalsOf,
} from '../overview/model'
import { ScopeSlot, useScope } from '../overview/ScopeSlot'
import { Sidebar, useSidebarOpen } from '../overview/Sidebar'
import { DayChart, Swatch, segmentLabel } from './DayChart'
import {
  agentSentence,
  cascade,
  changeAgainst,
  classSentence,
  concentration,
  type ExtraLine,
  migrateCostSearch,
  previousWindow,
  sidebarExtras,
  sidebarGap,
  windowDays,
} from './lens'
import {
  type Bucket,
  bucketsFor,
  CLASS_STACK,
  modelTone,
  OVERHEAD,
  parseStack,
  type Stack,
  stackOf,
  topModels,
  type Window,
} from './model'

const TEN_MIN = 600_000

const RANGE_CAPTION = { '1d': 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days' } as const

/** The uppercase muted label of a column or section, as the Overview's headers. */
const HEAD = 'text-faint text-meta uppercase tracking-wide'

export function CostPage() {
  useDocumentTitle('Cost')
  const scope = useScope()
  const { sp, set, select, range, custom, by, sel } = scope
  const [, setSp] = useSearchParams()
  const stack = parseStack(sp.get('stack'))
  const now = useNow(300_000)
  const [sbOpen, setSbOpen] = useSidebarOpen()

  // an old address (project, 90d, all, the cuts) becomes the same scope in the Overview's terms; Cost has no search
  const everyDay = useCost({ by: 'day' })
  const firstDay = everyDay.data ? (firstSpendDay(everyDay.data.rows) ?? null) : null
  const migrated = migrateCostSearch(sp, now, firstDay)
  const dropQ = sp.has('q')
  useEffect(() => {
    if (migrated instanceof URLSearchParams) {
      migrated.delete('q')
      setSp(migrated, { replace: true })
    } else if (migrated === null && dropQ) {
      const next = new URLSearchParams(sp)
      next.delete('q')
      setSp(next, { replace: true })
    }
  }, [migrated, dropQ, sp, setSp])
  const ready = migrated === null && !dropQ

  // the scope's days, whole local days as on the Overview
  const days = custom ?? presetRange(range, now)
  const win: Window = { since: days.from, until: days.to }
  const scoped = { since: days.from, until: days.to, place: sel === null ? undefined : by, in: sel ?? undefined }

  const head = useCost({ by: 'kind', ...scoped }, { enabled: ready })
  const dayRows = useCost({ by: 'day', split: stack === 'class' ? 'class' : 'model', ...scoped }, { enabled: ready })
  const byModel = useCost({ by: 'model', ...scoped }, { enabled: ready })
  const byClass = useCost({ by: 'class', ...scoped }, { enabled: ready })
  const byAgent = useCost({ by: 'agent', ...scoped }, { enabled: ready })
  // the period before: as many days just before the window, the same scope
  const before = previousWindow(days)
  const prev = useCost(
    { by: 'model', since: before.from, until: before.to, place: scoped.place, in: scoped.in },
    { enabled: ready },
  )

  // the places come from the Overview's lanes for the same days: the sidebar shows its figures
  const to = Math.ceil(now.getTime() / TEN_MIN) * TEN_MIN
  const w = customWindow(days, to)
  const overview = useOverview(
    { from: new Date(w.fromMs).toISOString(), to: new Date(w.toMs).toISOString(), slot: '1d' },
    ready,
  )
  const lanes = overview.data?.lanes
  const beads = overview.data?.beads
  const home = useMemo(() => inferHome(lanes?.flatMap((l) => (l.dir ? [l.dir] : [])) ?? []), [lanes])
  const tree = useMemo(() => buildPlaceTree(placeItems(lanes ?? [], by, beads), by, home), [lanes, by, beads, home])
  const all = useMemo(() => totalsOf(lanes ?? []), [lanes])

  const prevByModel = useMemo(() => new Map((prev.data?.rows ?? []).map((r) => [r.key, r.totalUSD])), [prev.data])
  // what the places leave out of the total, so that the sidebar adds up to it
  const scripted = overview.data?.scripted
  const overhead = byModel.data?.rows.find((r) => r.key === OVERHEAD)?.totalUSD ?? 0
  const extras = useMemo(
    () =>
      sidebarExtras({
        selected: sel !== null,
        scriptedUsd: scripted?.usd ?? 0,
        scriptedRuns: scripted?.sessions ?? 0,
        overheadUsd: overhead,
      }),
    [sel, scripted, overhead],
  )
  // the five models the chart colours: the biggest by spend, as the day chart picks them
  const modelTop = useMemo(
    () =>
      (byModel.data?.rows ?? [])
        .filter((r) => r.key !== OVERHEAD)
        .slice(0, 5)
        .map((r) => r.key),
    [byModel.data],
  )
  const conc = useMemo(
    () => concentration(selectLanes(lanes ?? [], sel, by, beads).map((l) => l.usd)),
    [lanes, sel, by, beads],
  )

  if (!ready) return <Skeleton className="m-4 h-64" />

  const empty = head.data !== undefined && head.data.rows.length === 0 && head.data.total.totalUSD === 0
  const change =
    byModel.data && prev.data
      ? changeAgainst(byModel.data.total.totalUSD, prev.data.total.totalUSD, windowDays(days))
      : null
  const caption = custom ? customLabel(custom, now) : RANGE_CAPTION[range]
  const overviewTo = `/${scopeSearch(sp, { q: false })}`

  return (
    <div className="flex h-full w-full bg-surface">
      <ScopeSlot scope={scope} home={home} beads={beads} search={false} />
      <Sidebar
        open={sbOpen}
        onOpen={setSbOpen}
        by={by}
        onBy={(v) => set({ by: v === 'dir' ? undefined : v, in: keepSelection(sel, lanes ?? [], v, beads) })}
        tree={tree}
        beads={beads}
        all={all}
        sel={sel}
        hover={null}
        onSelect={select}
        extra={extras}
      />
      <div className="min-w-0 flex-1 overflow-y-auto">
        {empty ? (
          <div className="p-6 text-muted">
            Nothing was spent {customPhrase(days, now)}
            {sel !== null && ` in ${displayPath(sel, home, by)}`}.{' '}
            {sel !== null && (
              <button type="button" onClick={() => select(null)} className="text-accent hover:underline">
                Clear the selection
              </button>
            )}
          </div>
        ) : (
          <>
            <Headline
              query={head}
              caption={sel !== null ? `${caption} · in ${displayPath(sel, home, by)}` : caption}
              change={change}
              concentration={
                conc && (
                  <Link
                    className="text-muted hover:text-accent"
                    to={`/${scopeSearch(sp, { q: false })}${scopeSearch(sp, { q: false }) ? '&' : '?'}sort=spend`}
                  >
                    {conc.n === 1 ? '1 session' : `${conc.n} sessions`} of {conc.of} {conc.n === 1 ? 'is' : 'are'} half
                    of it
                  </Link>
                )
              }
            />

            <Section
              title="By day"
              actions={
                <SegmentedControl
                  label="Stack by"
                  value={stack}
                  onChange={(v) => set({ stack: v === 'model' ? undefined : v })}
                  options={[
                    { value: 'model', label: 'By model' },
                    {
                      value: 'class',
                      label: 'Price class',
                      title: 'Stack by what the tokens were: cache reads, cache writes, output, uncached input',
                    },
                    {
                      value: 'compaction',
                      label: 'Compactions',
                      title:
                        'The days’ spend as above, empty, with what the compaction calls cost coloured at the bottom of each bar',
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
            </Section>

            <div className="grid grid-cols-[repeat(auto-fit,minmax(380px,1fr))] overflow-hidden border-line border-b">
              <div className="-mr-px -mb-px border-line border-r border-b">
                <LensTable
                  query={byModel}
                  name="Model"
                  before={prevByModel}
                  tone={(r) => `var(--${modelTone(r.key, modelTop)})`}
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
                        <sup>1</sup> (overhead) is spend the harness reported that no transcript message explains. It
                        has no model of its own.
                      </>
                    )
                  }
                />
              </div>
              <div className="-mr-px -mb-px border-line border-r border-b">
                <LensTable
                  query={byClass}
                  name="Price class"
                  tone={(r) => `var(--${CLASS_STACK.find(([k]) => k === r.key)?.[1] ?? 'series-other'})`}
                  label={(r) => segmentLabel(r.key)}
                  footer={(d) => (
                    <>
                      {classSentence(d.rows)}
                      {d.rows.some((r) => r.key === '(unsplit)') && ' Not split: spend no token count explains.'} A
                      message’s spend is spread over its tokens at the price of each kind; cache writes are the 5-minute
                      and 1-hour ones together.
                    </>
                  )}
                />
              </div>
              <div className="-mr-px -mb-px border-line border-r border-b">
                <LensTable
                  query={head}
                  name="Kind"
                  label={(r) => (
                    <span title={r.label}>{r.key === 'sdk' ? 'sdk (scripted runs with spend)' : r.key}</span>
                  )}
                />
                <LensTable
                  query={byAgent}
                  name="Agents"
                  label={(r) =>
                    r.key === 'main'
                      ? 'Main thread'
                      : r.key === 'agents'
                        ? 'Sub-agents, teammates and forks'
                        : 'Not split'
                  }
                  footer={(d) => (
                    <>
                      {agentSentence(d.rows)} The main thread is the messages with no agent; reported spend no message
                      carries is not split.
                    </>
                  )}
                />
              </div>
            </div>
            <HowMade
              query={head}
              placesUsd={
                sel === null ? all.usd : selectLanes(lanes ?? [], sel, by, beads).reduce((n, l) => n + l.usd, 0)
              }
              extras={extras}
            />
            <p className="px-4 py-3 text-sec text-muted">
              <Link to={overviewTo} className="inline-flex items-center gap-1">
                <Search size={12} aria-hidden /> The sessions behind these figures →
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  )
}

/** A section of the pane: the Overview's column-header style label, an action at the right, a hairline under. */
function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-line border-b">
      <div className="flex min-h-9 items-center justify-between gap-3 px-4 pt-2">
        <h2 className={HEAD}>{title}</h2>
        {actions}
      </div>
      <div className="px-4 pt-1 pb-3">{children}</div>
    </section>
  )
}

function Headline({
  query,
  caption,
  change,
  concentration,
}: {
  query: CutQuery
  caption: string
  change: ReturnType<typeof changeAgainst>
  concentration: ReactNode
}) {
  return (
    <section className="border-line border-b px-4 py-3">
      <QueryBoundary query={query} skeleton={<Skeleton className="h-16" />}>
        {(d) => (
          <>
            <div className={HEAD}>{caption}</div>
            <div className="flex flex-wrap items-baseline gap-x-8 gap-y-1">
              <span className="text-page" data-testid="total">
                <Money usd={d.total.totalUSD} lowerBound={backingLowerBound(d.backing)} />
              </span>
              {change && (
                <span className="text-body text-muted" title={change.title} data-testid="change">
                  {change.text}
                </span>
              )}
              {concentration && <span className="text-body">{concentration}</span>}
            </div>
          </>
        )}
      </QueryBoundary>
    </section>
  )
}

/**
 * "How these figures are made", the one place provenance shows: what the harnesses reported and what Merlin worked
 * out, how well backed the figure is, and how the sidebar adds up to the total. A quiet, closed `<details>` at the
 * end of the pane.
 */
function HowMade({ query, placesUsd, extras }: { query: CutQuery; placesUsd: number; extras: ExtraLine[] }) {
  return (
    <QueryBoundary query={query} skeleton={null}>
      {(d) => {
        const { reportedUSD, attributedUSD, totalUSD } = d.total
        const recordedUSD = d.total.recordedUSD ?? 0
        const gap = sidebarGap(totalUSD, placesUsd, extras)
        return (
          <details className="group border-line border-b px-4 py-2 text-sec text-muted" data-testid="how-made">
            <summary className="cursor-pointer select-none text-faint text-meta uppercase tracking-wide hover:text-fg">
              How these figures are made
            </summary>
            <div className="max-w-[110ch] space-y-1.5 pt-2 pb-1">
              <p>
                {formatMoney(reportedUSD)} is what the harnesses reported themselves; {formatMoney(attributedUSD)}{' '}
                Merlin worked out from token counts where they reported nothing
                {recordedUSD > 0 && (
                  <>
                    ; {formatMoney(recordedUSD)} is {recordedNote(recordedUSD, d.total.billedUSD ?? 0)}
                  </>
                )}
                .
              </p>
              <p>{backingSentence(d.backing)}</p>
              {(d.backing.unknown ?? 0) > 0 && <p data-testid="unknown-line">{unknownNote(d.backing.unknown ?? 0)}</p>}
              <p data-testid="sidebar-sum">
                The sidebar adds up to the total: the places {cents(placesUsd)}
                {extras.map((e) => ` + ${e.label.toLowerCase()} ${cents(e.usd)}`)} = {cents(totalUSD)}
                {Math.abs(gap) >= 0.005 && ` (${cents(Math.abs(gap))} not placed)`}.
              </p>
            </div>
          </details>
        )
      }}
    </QueryBoundary>
  )
}

/** What the Recorded source is: the harness's own per-call figures, and how much of them the provider billed. */
function recordedNote(recordedUSD: number, billedUSD: number): string {
  const own = "the harness's own per-call figures"
  if (billedUSD <= 0) return `${own}, its price-catalog estimate`
  if (billedUSD >= recordedUSD - 1e-9) return `${own}, billed by the provider per call`
  return `${own}; ${formatMoney(billedUSD)} of it billed by the provider per call, the rest its catalog estimate`
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
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-muted" aria-hidden />
            <span className="size-2 rounded-full bg-bad" aria-hidden />a day with compactions (red: one ran cold)
          </span>
        )}
        {weekly && <span className="ml-auto text-faint">One bar per week (Mon to Sun)</span>}
      </div>
      <CompactionNote buckets={buckets} always={stack === 'compaction'} />
    </div>
  )
}

/**
 * One line under the chart, whatever the stack: what the compaction calls cost and what a warm cache would have.
 * A compaction is one more call over the whole context; with a warm cache that is a cache read, after an idle gap
 * longer than the cache lifetime it is read again at full price. The figures are estimates and are kept out of the
 * spend (Claude Code does not record the call; Codex does, and its calls are in the spend like any other).
 */
function CompactionNote({ buckets, always }: { buckets: Bucket[]; always: boolean }) {
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
  if (calls === 0) return always ? <p className="text-sec text-muted">No compactions in this range.</p> : null
  return (
    <p
      className="max-w-[110ch] text-sec text-muted"
      data-testid="compaction-chart-note"
      title="A compaction sends the whole context once more to write the summary: warm, that is a cache read; after the main agent sat idle longer than the cache lifetime, it is read again at full price. Compacting before a long break, or right after coming back while the turn is still cached, keeps it cheap. Estimated from the context size: Claude Code does not record the call, so these figures are not in the spend above."
    >
      {plural(calls, 'compaction')}, ~{formatMoney(usd)}
      {cold > 0 ? (
        <>
          , <span className="text-bad">{cold} of them cold</span>
        </>
      ) : (
        ', all warm'
      )}
      . With a warm cache every time: ~{formatMoney(warm)}.
    </p>
  )
}

function legendOf(buckets: Bucket[], stack: Stack, top: string[]) {
  const seen = new Map<string, ReturnType<typeof modelTone>>()
  for (const b of buckets) for (const s of stackOf(b, stack, top)) seen.set(s.key, s.tone)
  const order =
    stack === 'class'
      ? CLASS_STACK.map(([k]) => k)
      : stack === 'compaction'
        ? ['compaction-warm', 'compaction-cold']
        : [...top, 'other', OVERHEAD]
  return order.filter((k) => seen.has(k)).map((key) => ({ key, tone: seen.get(key) as ReturnType<typeof modelTone> }))
}

type CutQuery = Parameters<typeof QueryBoundary<CostTable>>[0]['query']

function LensTable({
  query,
  name,
  label,
  footer,
  before,
  tone,
}: {
  query: CutQuery
  name: string
  label: (r: CostRow) => ReactNode
  footer?: (d: CostTable) => ReactNode
  /** The total of each row in the period before: a small change beside the figures. */
  before?: ReadonlyMap<string, number>
  /** The colour of a row's share bar (a CSS colour); the accent when absent. */
  tone?: (r: CostRow) => string
}) {
  return (
    <QueryBoundary
      query={query}
      skeleton={<SkeletonRows rows={4} height={28} />}
      empty={<EmptyState title="Nothing in this range" />}
      isEmpty={(d) => d.rows.length === 0}
    >
      {(d) => {
        const note = footer?.(d)
        const rows = d.rows.filter((r) => !(r.key === '(unsplit)' && r.totalUSD === 0))
        // one cascade: each row's bar starts where the row above ended, so the segments walk once across the width
        const bars = cascade(
          rows.map((r) => r.totalUSD),
          d.total.totalUSD,
          0,
        )
        return (
          <div className="@container">
            <table className="w-full table-fixed text-sec">
              <thead>
                <tr className={cn(HEAD, 'h-9')}>
                  <th className="px-4 text-left font-normal">{name}</th>
                  <th className="w-20 px-2 text-right font-normal">Total</th>
                  {before ? (
                    <th className="hidden w-20 px-2 pr-4 text-right font-normal @min-[400px]:table-cell">Before</th>
                  ) : (
                    <th className="w-4" />
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.key} className="h-[34px]" title={`${formatCount(r.sessions)} sessions`}>
                    <td className="min-w-0 px-4 py-1">
                      <div className="truncate text-body">{label(r)}</div>
                      <div
                        className="relative mt-0.5 h-[3px] overflow-hidden rounded-full bg-surface-2"
                        role="img"
                        aria-label={`${share(r.totalUSD, d.total.totalUSD)} of the total`}
                      >
                        <span
                          className="absolute inset-y-0 rounded-full"
                          style={{
                            left: `${bars[i].from * 100}%`,
                            width: `${bars[i].width * 100}%`,
                            minWidth: r.totalUSD > 0 ? 2 : 0,
                            background: tone ? tone(r) : 'var(--accent)',
                          }}
                        />
                      </div>
                    </td>
                    <td className="px-2 text-right">
                      <Money usd={r.totalUSD} lowerBound={lowerBoundNote(0, 0, r.unrecordedAgents)} />
                    </td>
                    {before ? (
                      <td className="hidden px-2 pr-4 text-right text-meta text-muted @min-[400px]:table-cell">
                        <Delta now={r.totalUSD} before={before.get(r.key)} />
                      </td>
                    ) : (
                      <td />
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {note && <p className="px-4 pt-1 pb-3 text-meta text-muted">{note}</p>}
          </div>
        )
      }}
    </QueryBoundary>
  )
}

/** Dollars to the cent: the arithmetic of the sidebar is read to the cent. */
const cents = (usd: number): string =>
  `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%'
}

/** A row's change against the period before: ▲ or ▼ with the percentage, the dollars on hover. */
function Delta({ now, before }: { now: number; before: number | undefined }) {
  if (before === undefined || !(before > 0)) return <span className="text-faint">–</span>
  const d = now - before
  const pct = Math.round((Math.abs(d) / before) * 100)
  if (pct === 0) return <span className="text-faint">=</span>
  return (
    <span title={`${d > 0 ? '+' : '−'}${formatMoney(Math.abs(d))} against ${formatMoney(before)}`}>
      {d > 0 ? '▲' : '▼'} {pct}%
    </span>
  )
}
