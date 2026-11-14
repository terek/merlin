// The Cost page (docs/ui.md section 10): the Overview's scope read as money, in the Overview's frame: its sidebar
// (the places, where the selection lives), then one pane edge to edge. The scope is the Overview's URL (`range`,
// `from`, `to`, `by`, `in`; Cost has no search) and the range capsule in the top bar.

import { Search } from 'lucide-react'
import { type ReactNode, useEffect, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useCost, useOverview } from '../../api/queries'
import type { CostRow, CostTable } from '../../api/types'
import { cn } from '../../lib/cn'
import { tallyLine, warmLine } from '../../lib/compaction'
import { backingLowerBound, backingSentence, lowerBoundNote, unknownNote } from '../../lib/cost'
import { formatCount, formatMoney, plural } from '../../lib/format'
import { useDocumentTitle, useNow } from '../../lib/hooks'
import { modelLabel } from '../../lib/models'
import { scopeSearch } from '../../lib/scope'
import { Bar, EmptyState, Money, QueryBoundary, SegmentedControl, Skeleton, SkeletonRows } from '../../ui'
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
  totalsOf,
} from '../overview/model'
import { ScopeSlot, useScope } from '../overview/ScopeSlot'
import { Sidebar, useSidebarOpen } from '../overview/Sidebar'
import { DayChart, Swatch, segmentLabel } from './DayChart'
import { migrateCostSearch } from './lens'
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
  const dayRows = useCost({ by: 'day', split: 'model', ...scoped }, { enabled: ready })
  const byModel = useCost({ by: 'model', ...scoped }, { enabled: ready })

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

  if (!ready) return <Skeleton className="m-4 h-64" />

  const empty = head.data !== undefined && head.data.rows.length === 0 && head.data.total.totalUSD === 0
  const overhead = byModel.data?.rows.find((r) => r.key === OVERHEAD)?.totalUSD ?? 0
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
              overheadUSD={overhead}
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
            </Section>

            <div className="grid grid-cols-[repeat(auto-fit,minmax(380px,1fr))] gap-px border-line border-b bg-line">
              <div className="bg-surface">
                <LensTable
                  query={byModel}
                  name="Model"
                  detail
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
              <div className="bg-surface">
                <LensTable
                  query={head}
                  name="Kind"
                  label={(r) => (
                    <span title={r.label}>{r.key === 'sdk' ? 'sdk (scripted runs with spend)' : r.key}</span>
                  )}
                />
              </div>
            </div>
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

function Headline({ query, caption, overheadUSD }: { query: CutQuery; caption: string; overheadUSD: number }) {
  return (
    <section className="border-line border-b px-4 py-3">
      <QueryBoundary query={query} skeleton={<Skeleton className="h-16" />}>
        {(d) => {
          const { totalUSD, reportedUSD, attributedUSD } = d.total
          const recordedUSD = d.total.recordedUSD ?? 0
          return (
            <div className="grid items-center gap-x-10 gap-y-3 grid-cols-[auto_1fr]">
              <div>
                <div className="text-faint text-meta uppercase tracking-wide">{caption}</div>
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
    </section>
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

function LensTable({
  query,
  name,
  label,
  footer,
  detail,
}: {
  query: CutQuery
  name: string
  label: (r: CostRow) => ReactNode
  footer?: (d: CostTable) => ReactNode
  /** Reported and attributed columns beside the total. */
  detail?: boolean
}) {
  return (
    <QueryBoundary
      query={query}
      skeleton={<SkeletonRows rows={4} height={28} />}
      empty={<EmptyState title="Nothing in this range" />}
      isEmpty={(d) => d.rows.length === 0}
    >
      {(d) => {
        const recorded = (d.total.recordedUSD ?? 0) > 0
        const note = footer?.(d)
        return (
          <div className="@container">
            <table className="w-full table-fixed text-sec">
              <thead>
                <tr className={cn(HEAD, 'h-9')}>
                  <th className="px-4 text-left font-normal">{name}</th>
                  <th className="w-20 px-2 text-right font-normal">Total</th>
                  {detail && (
                    <th className="hidden w-20 px-2 text-right font-normal @min-[440px]:table-cell">Reported</th>
                  )}
                  {detail && (
                    <th className="hidden w-20 px-2 pr-4 text-right font-normal @min-[440px]:table-cell">Attributed</th>
                  )}
                  {!detail && <th className="w-4" />}
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.key} className="h-[34px]" title={`${formatCount(r.sessions)} sessions`}>
                    <td className="min-w-0 px-4 py-1">
                      <div className="truncate text-body">{label(r)}</div>
                      <Bar
                        height={3}
                        className="mt-0.5"
                        label={`${share(r.totalUSD, d.total.totalUSD)} of the total`}
                        segments={[{ value: r.totalUSD, tone: r.key === OVERHEAD ? 'overhead' : 'accent' }]}
                        total={d.total.totalUSD}
                      />
                    </td>
                    <td
                      className="px-2 text-right"
                      title={`Reported ${formatMoney(r.reportedUSD)} · attributed ${formatMoney(r.attributedUSD)}${recorded ? ` · recorded ${formatMoney(r.recordedUSD ?? 0)}` : ''}`}
                    >
                      <Money usd={r.totalUSD} lowerBound={lowerBoundNote(0, 0, r.unrecordedAgents)} />
                    </td>
                    {detail && (
                      <td className="hidden px-2 text-right @min-[440px]:table-cell">
                        <Money usd={r.reportedUSD} dim />
                      </td>
                    )}
                    {detail && (
                      <td className="hidden px-2 pr-4 text-right @min-[440px]:table-cell">
                        <Money usd={r.attributedUSD} dim />
                      </td>
                    )}
                    {!detail && <td />}
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

function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%'
}
