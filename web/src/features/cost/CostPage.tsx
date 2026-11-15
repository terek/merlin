// The Cost page (docs/ui.md section 10): the Overview's scope read as money, in the Overview's frame: its sidebar
// (the places, where the selection lives), then one pane edge to edge. The scope is the Overview's URL (`range`,
// `from`, `to`, `by`, `in`; Cost has no search) and the range capsule in the top bar.

import { type ReactNode, useEffect, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useCost, useLimits, useOverview, usePrices } from '../../api/queries'
import type { CostRow, CostTable } from '../../api/types'
import { cn } from '../../lib/cn'
import { backingLowerBound, backingSentence, lowerBoundNote, unknownNote } from '../../lib/cost'
import { formatCount, formatMoney, plural } from '../../lib/format'
import { useDocumentTitle, useNow } from '../../lib/hooks'
import { modelLabel } from '../../lib/models'
import { classColor, depthColor, HATCH, modelColor, tierColor } from '../../lib/palette'
import { scopeSearch } from '../../lib/scope'
import type { Prices, Tier } from '../../lib/tiers'
import { PanelTab } from '../../shell/Panel'
import { EmptyState, FrameSection, Money, QueryBoundary, SegmentedControl, Skeleton, SkeletonRows } from '../../ui'
import {
  buildPlaceTree,
  customPhrase,
  customWindow,
  displayPath,
  firstSpendDay,
  formatCustom,
  inferHome,
  isWindowRange,
  keepSelection,
  placeItems,
  presetRange,
  selectLanes,
  totalsOf,
  windowLength,
} from '../overview/model'
import { ScopeSlot, useScope } from '../overview/ScopeSlot'
import { Sidebar, useSidebarOpen } from '../overview/Sidebar'
import { scopeWindows } from '../overview/windows'
import { DayChart, Swatch, segmentLabel } from './DayChart'
import { Limits } from './LimitsSection'
import {
  cascade,
  changeAgainst,
  classSentence,
  concentration,
  costRange,
  depthSentence,
  type ExtraLine,
  migrateCostSearch,
  previousWindow,
  sidebarExtras,
  sidebarGap,
  tierColumns,
  whoByDepth,
  whoByTier,
  whoTierSentence,
  windowDays,
} from './lens'
import {
  type Bucket,
  bucketDay,
  bucketsFor,
  CLASS_STACK,
  DEPTH_STACK,
  depthLabel,
  grainFor,
  isHourly,
  OVERHEAD,
  parseStack,
  type Stack,
  splitOf,
  stackOf,
  topModels,
  WHO_STACK,
  type Window,
} from './model'

/** A table's share bar cannot be hatched: (overhead) is its solid hue there. */
const tableColor = (c: string) => (c === HATCH ? 'var(--overhead)' : c)

const TEN_MIN = 600_000

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
  const win: Window = {
    since: days.from,
    until: days.to,
    clock: isWindowRange(days) && days.toMs - days.fromMs < 2 * 86_400_000 ? days : undefined,
  }
  const harness = custom?.harness
  const nowMs = now.getTime()
  const scoped = {
    ...costRange(days, nowMs),
    harness,
    place: sel === null ? undefined : by,
    in: sel ?? undefined,
  }

  const head = useCost({ by: 'kind', ...scoped }, { enabled: ready })
  // the bars: hours up to 14 days (`by=hour` answers no more), days beyond (weeks are days added up)
  const grain = grainFor(windowDays(days))
  const dayRows = useCost(
    { by: isHourly(grain) ? 'hour' : 'day', split: splitOf(stack), ...scoped },
    { enabled: ready },
  )
  const prices = usePrices().data?.models
  const byModel = useCost({ by: 'model', ...scoped }, { enabled: ready })
  const byClass = useCost({ by: 'class', ...scoped }, { enabled: ready })
  const byAgentModel = useCost({ by: 'agent', split: 'model', ...scoped }, { enabled: ready })
  const byAgentDepth = useCost({ by: 'agent', split: 'depth', ...scoped }, { enabled: ready })
  // the period before: as many days just before the window, the same scope
  const before = previousWindow(days)
  const prev = useCost(
    { by: 'model', ...costRange(before), harness, place: scoped.place, in: scoped.in },
    { enabled: ready },
  )

  // the places come from the Overview's lanes for the same days: the sidebar shows its figures
  const to = Math.ceil(now.getTime() / TEN_MIN) * TEN_MIN
  const w = customWindow(days, to)
  const overview = useOverview(
    { from: new Date(w.fromMs).toISOString(), to: new Date(w.toMs).toISOString(), slot: '1d' },
    ready,
  )
  // under a limit window's harness only that harness's sessions are the places; scripted runs are not placed
  const lanes = useMemo(
    () => (harness ? overview.data?.lanes.filter((l) => l.harness === harness) : overview.data?.lanes),
    [overview.data, harness],
  )
  const beads = overview.data?.beads
  const home = useMemo(() => inferHome(lanes?.flatMap((l) => (l.dir ? [l.dir] : [])) ?? []), [lanes])
  const tree = useMemo(() => buildPlaceTree(placeItems(lanes ?? [], by, beads), by, home), [lanes, by, beads, home])
  const all = useMemo(() => totalsOf(lanes ?? []), [lanes])

  const limits = useLimits(ready).data
  const windows = useMemo(
    () => scopeWindows(limits?.windows ?? [], w.fromMs, w.toMs, harness),
    [limits, w.fromMs, w.toMs, harness],
  )

  const prevByModel = useMemo(() => new Map((prev.data?.rows ?? []).map((r) => [r.key, r.totalUSD])), [prev.data])
  // what the places leave out of the total, so that the sidebar adds up to it
  const scripted = harness ? undefined : overview.data?.scripted
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
  const conc = useMemo(
    () => concentration(selectLanes(lanes ?? [], sel, by, beads).map((l) => l.usd)),
    [lanes, sel, by, beads],
  )

  if (!ready) return <Skeleton className="m-4 h-64" />

  const empty = head.data !== undefined && head.data.rows.length === 0 && head.data.total.totalUSD === 0
  const change =
    byModel.data && prev.data
      ? changeAgainst(
          byModel.data.total.totalUSD,
          prev.data.total.totalUSD,
          windowDays(days),
          isWindowRange(days) ? `the ${windowLength(days.toMs - days.fromMs)} before` : undefined,
        )
      : null

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
      <div className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
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

            <Limits windows={windows} sp={sp} onWindow={scope.scopeTo} />

            <Section
              title={sectionTitle(grain)}
              actions={
                <SegmentedControl
                  label="Stack by"
                  value={stack}
                  onChange={(v) => set({ stack: v === 'model' ? undefined : v })}
                  options={[
                    { value: 'model', label: 'By model' },
                    { value: 'who', label: 'Who', title: 'Stack by the main thread and the sub-agents' },
                    {
                      value: 'class',
                      label: 'Price class',
                      title: 'Stack by what the tokens were: cache reads, cache writes, output, uncached input',
                    },
                    {
                      value: 'tier',
                      label: 'Tier',
                      title: 'Stack by what the model costs: heavy, mid and light models, heavy at the bottom',
                    },
                    {
                      value: 'depth',
                      label: 'Depth',
                      title: 'Stack by the context the call carried: under 100k at the bottom, 500k or more on top',
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
                    prices={prices}
                    onPick={(b) => set({ range: undefined, ...formatCustom({ from: bucketDay(b), to: b.to }) })}
                  />
                )}
              </QueryBoundary>
            </Section>

            <Section title="Context depth">
              <WhoDepth query={byAgentDepth} />
            </Section>

            <div className="grid grid-cols-[repeat(auto-fit,minmax(380px,1fr))] overflow-hidden border-line border-b">
              <div className="-mr-px -mb-px border-line border-r border-b">
                <LensTable
                  query={byModel}
                  name="Model"
                  before={prevByModel}
                  tone={(r) => tableColor(modelColor(r.key))}
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
                  tone={(r) => classColor(r.key)}
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
                <WhoTier query={byAgentModel} prices={prices} />
              </div>
            </div>
            <HowMade
              query={head}
              placesUsd={
                sel === null ? all.usd : selectLanes(lanes ?? [], sel, by, beads).reduce((n, l) => n + l.usd, 0)
              }
              extras={extras}
            />
          </>
        )}
      </div>
    </div>
  )
}

/** A section of the pane: the Overview's column-header style label, an action at the right, a hairline under. */
const Section = FrameSection

function Headline({
  query,
  change,
  concentration,
}: {
  query: CutQuery
  change: ReturnType<typeof changeAgainst>
  concentration: ReactNode
}) {
  return (
    <section className="border-line border-b px-4 py-3">
      <QueryBoundary query={query} skeleton={<Skeleton className="h-16" />}>
        {(d) => (
          <>
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

/** The section's name: what a bar stands for. */
function sectionTitle(grain: ReturnType<typeof grainFor>): string {
  if (grain === 'week') return 'By week'
  if (grain === 'day') return 'By day'
  return grain === 1 ? 'By hour' : `By ${grain} hours`
}

function ChartBody({
  rows,
  win,
  stack,
  prices,
  onPick,
}: {
  rows: CostRow[]
  win: Window
  stack: Stack
  prices?: Prices
  onPick: (b: Bucket) => void
}) {
  const buckets = useMemo(() => bucketsFor(rows, win), [rows, win])
  const top = useMemo(() => topModels(buckets), [buckets])
  const legend = useMemo(() => legendOf(buckets, stack, top, prices), [buckets, stack, top, prices])
  const weekly = buckets[0]?.weekly
  const hours = buckets[0]?.hours
  if (buckets.length === 0) return <EmptyState title="No days in this range" />
  return (
    <div className="space-y-2">
      <PanelTab id="cost" title="Cost">
        <CostKey stack={stack} legend={legend} />
      </PanelTab>
      <DayChart buckets={buckets} stack={stack} top={top} prices={prices} onSelect={onPick} />
      {(weekly || hours) && (
        <p className="text-faint text-sec">
          {weekly
            ? 'One bar per week (Mon to Sun)'
            : `One bar per ${hours === 1 ? 'hour' : `${hours} hours`}; a click selects its day`}
        </p>
      )}
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

const STACK_HEAD: Record<Stack, string> = {
  model: 'By model',
  who: 'Who',
  class: 'Price class',
  tier: 'Tier',
  depth: 'Depth',
  compaction: 'Compactions',
}

/** A muted second line for the categories whose meaning is not in their name. */
const GIST: Record<string, string> = {
  cacheRead: 'Context read back from the cache; the cheap one, and usually the most tokens.',
  cacheWrite: 'Context written to the cache the first time, at a premium.',
  output: 'What the model wrote.',
  input: 'Prompt tokens that missed the cache.',
  heavy: 'The costliest models.',
  mid: 'Models in the middle of the price range.',
  light: 'The cheapest models.',
  unknown: 'No price known, so no dollars here.',
  '0-100k': 'Context the call carried, input plus cache.',
  '500k+': 'The deepest calls: each re-reads half a million tokens or more.',
  'compaction-warm': 'What a compaction costs when the cache is still warm (a cache read).',
  'compaction-cold': 'The extra when the cache had gone cold and the context was read at full price.',
}

/**
 * Cost's colour key, in the legend panel: the stack in view, its categories top of the bars first (so the list
 * reads like the bars), then the marks that apply.
 */
function CostKey({ stack, legend }: { stack: Stack; legend: { key: string; color: string }[] }) {
  const rows = [...legend].reverse()
  return (
    <div data-testid="cost-key" className="space-y-3 text-sec">
      <div className={HEAD}>{STACK_HEAD[stack]}</div>
      <ul className="m-0 list-none space-y-2 p-0">
        {rows.map((l) => (
          <li key={l.key} className="flex items-start gap-2">
            <span className="mt-[5px]">
              <Swatch color={l.color} />
            </span>
            <span className="min-w-0">
              <span className="text-fg">
                {l.key === OVERHEAD ? 'Not in any session’s messages' : segmentLabel(l.key)}
              </span>
              {GIST[l.key] && <span className="block text-muted">{GIST[l.key]}</span>}
            </span>
          </li>
        ))}
        {stack === 'compaction' && rows.length > 0 && (
          <li className="flex items-start gap-2">
            <span className="mt-[5px] inline-flex gap-0.5">
              <span className="size-2 rounded-full bg-muted" aria-hidden />
              <span className="size-2 rounded-full bg-bad" aria-hidden />
            </span>
            <span className="min-w-0 text-fg">
              A day with compactions
              <span className="block text-muted">Red: one of them ran cold.</span>
            </span>
          </li>
        )}
      </ul>
    </div>
  )
}

function legendOf(buckets: Bucket[], stack: Stack, top: string[], prices?: Prices) {
  const seen = new Map<string, string>()
  for (const b of buckets) for (const s of stackOf(b, stack, top, prices)) seen.set(s.key, s.color)
  const order =
    stack === 'class'
      ? CLASS_STACK
      : stack === 'who'
        ? WHO_STACK
        : stack === 'tier'
          ? ['heavy', 'mid', 'light', 'unknown', OVERHEAD]
          : stack === 'depth'
            ? [...DEPTH_STACK, OVERHEAD]
            : stack === 'compaction'
              ? ['compaction-warm', 'compaction-cold']
              : [...top, 'other', OVERHEAD]
  return order.filter((k) => seen.has(k)).map((key) => ({ key, color: seen.get(key) as string }))
}

const whoLabel = (key: string) => (key === 'main' ? 'Main thread' : key === 'agents' ? 'Sub-agents' : 'Not split')

/**
 * The table Who × Tier and Who × Depth share: a row per main thread, sub-agents and not split; a column per tier or
 * band, the overhead only when the main thread or the sub-agents have some (not split is overhead alone), and the total. The Who column keeps the width of "Main thread".
 */
function WhoMatrix<R extends { key: string; total: number; overhead: number }>({
  rows,
  cols,
  value,
  testId,
}: {
  rows: R[]
  cols: { key: string; color: string; label: string; keepCase?: boolean }[]
  value: (r: R, col: string) => number
  testId: string
}) {
  // the not-split row is overhead alone, its total says it: the column only when the main thread or the agents have some
  const overhead = rows.some((r) => r.overhead > 0 && (r.key === 'main' || r.key === 'agents'))
  const dash = <span className="text-faint">{'–'}</span>
  return (
    <table className="w-full whitespace-nowrap text-sec" data-testid={testId}>
      <thead>
        <tr className={cn(HEAD, 'h-9')}>
          <th className="min-w-24 pr-1 pl-4 text-left font-normal">Who</th>
          {cols.map((c) => (
            <th key={c.key} className="px-1 text-right font-normal">
              <span className={cn('inline-flex items-center gap-1', c.keepCase && 'normal-case')}>
                <Swatch color={c.color} />
                {c.label}
              </span>
            </th>
          ))}
          {overhead && <th className="px-1 text-right font-normal">Overhead</th>}
          <th className="pr-4 pl-1 text-right font-normal">Total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="h-[34px]" data-testid={`who-${r.key}`}>
            <td className="pr-1 pl-4 text-fg">{whoLabel(r.key)}</td>
            {cols.map((c) => (
              <td key={c.key} className="px-1 text-right">
                {value(r, c.key) > 0 ? <Money usd={value(r, c.key)} /> : dash}
              </td>
            ))}
            {overhead && <td className="px-1 text-right">{r.overhead > 0 ? <Money usd={r.overhead} /> : dash}</td>}
            <td className="pr-4 pl-1 text-right">
              <Money usd={r.total} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * Who × Tier: dollars of the main thread and the sub-agents on heavy, mid and light models (the unpriced only when
 * there are some), from `by=agent&split=model`, and one sentence of what the figures show.
 */
function WhoTier({ query, prices }: { query: CutQuery; prices?: Prices }) {
  return (
    <QueryBoundary
      query={query}
      skeleton={<SkeletonRows rows={3} height={28} />}
      empty={<EmptyState title="Nothing in this range" />}
      isEmpty={(d) => d.rows.length === 0}
    >
      {(d) => {
        const rows = whoByTier(d.rows, prices)
        const cols = tierColumns(rows).map((t) => ({
          key: t,
          color: tierColor(t),
          label: segmentLabel(t).replace(' models', ''),
        }))
        const sentence = whoTierSentence(rows)
        return (
          <div className="@container" data-testid="who-tier">
            <WhoMatrix rows={rows} cols={cols} value={(r, t) => r.tiers[t as Tier]} testId="who-tier-table" />
            <p className="px-4 pt-1 pb-3 text-meta text-muted">
              {sentence} The main thread is the messages with no agent; reported spend no message carries is not split.
              A model’s tier is its input price: heavy from $4 per million tokens, light up to $1.
            </p>
          </div>
        )
      }}
    </QueryBoundary>
  )
}

/**
 * Who × Depth: dollars of the main thread and the sub-agents by the context of the call that made them
 * (`by=agent&split=depth`), and one sentence of what the figures show.
 */
function WhoDepth({ query }: { query: CutQuery }) {
  return (
    <QueryBoundary
      query={query}
      skeleton={<SkeletonRows rows={3} height={28} />}
      empty={<EmptyState title="Nothing in this range" />}
      isEmpty={(d) => d.rows.length === 0}
    >
      {(d) => {
        const rows = whoByDepth(d.rows)
        const cols = DEPTH_STACK.map((k) => ({ key: k, color: depthColor(k), label: depthLabel(k), keepCase: true }))
        const sentence = depthSentence(rows)
        return (
          <div data-testid="who-depth">
            <div className="max-w-[560px]">
              <WhoMatrix
                rows={rows}
                cols={cols}
                value={(r, k) => r.bands[DEPTH_STACK.indexOf(k)]}
                testId="who-depth-table"
              />
            </div>
            <p className="max-w-[110ch] px-4 pt-1 text-sec">{sentence}</p>
            <p className="max-w-[110ch] px-4 pt-1 pb-3 text-meta text-muted">
              Every call reads its whole context again, so what a call costs grows with it. A call’s context is its
              input plus cache reads and writes; calls at 200k or more are the deep ones. Reported spend no call carries
              is not split.
            </p>
          </div>
        )
      }}
    </QueryBoundary>
  )
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
