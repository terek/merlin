// The Cost page (docs/ui.md section 10): what was spent, when, on which project and model, and how
// well backed the figure is. Controls are in the URL: range, project, stack, and from / to for a
// selected bar. Every table and the chart are cuts of one sum; the headline shows it once.

import { X } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useCost, useProjects } from '../../api/queries'
import type { CostRow, CostTable } from '../../api/types'
import { backingSentence } from '../../lib/cost'
import { formatCount } from '../../lib/format'
import { useDocumentTitle } from '../../lib/hooks'
import { modelLabel } from '../../lib/models'
import { sessionPath, shortProject } from '../../lib/paths'
import { dayStart, shortDate } from '../../lib/time'
import {
  Bar,
  Button,
  Card,
  DataTable,
  EmptyState,
  Money,
  ProjectName,
  QueryBoundary,
  RelTime,
  SegmentedControl,
  Select,
  Skeleton,
  SkeletonRows,
} from '../../ui'
import type { Column } from '../../ui/layout'
import { DayChart, Swatch, segmentLabel } from './DayChart'
import {
  type Bucket,
  bucketsFor,
  type modelTone,
  OVERHEAD,
  parseDay,
  parseRange,
  parseStack,
  RANGES,
  type Range,
  rangeWindow,
  selectedWindow,
  stackOf,
  topModels,
  windowCaption,
} from './model'

const ALL = ''

const dayText = (d: string) => (d ? shortDate(dayStart(d)) : '')

export function CostPage() {
  useDocumentTitle('Cost')
  const [sp, setSp] = useSearchParams()
  const range = parseRange(sp.get('range'))
  const project = sp.get('project') || undefined
  const stack = parseStack(sp.get('stack'))
  const from = parseDay(sp.get('from'))
  const sel = selectedWindow(from, parseDay(sp.get('to')))

  const set = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(sp)
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined || v === '') next.delete(k)
      else next.set(k, v)
    }
    setSp(next, { replace: false })
  }

  // The chart always shows the whole range; the figures follow a selected bar when there is one.
  const chartWin = useMemo(() => rangeWindow(range), [range])
  const win = sel ?? chartWin
  const q = { project, since: win.since, until: win.until }

  const head = useCost({ by: 'kind', ...q })
  const days = useCost({ by: 'day', split: 'model', project, since: chartWin.since, until: chartWin.until })
  const byProject = useCost({ by: 'project', ...q })
  const byModel = useCost({ by: 'model', ...q })
  const byKind = head
  const top = useCost({ by: 'session', limit: 50, ...q })
  const projects = useProjects()

  const empty = head.data !== undefined && head.data.rows.length === 0 && head.data.total.totalUSD === 0

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-page">Cost</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            label="Project"
            value={project ?? ALL}
            onChange={(v) => set({ project: v })}
            options={[
              { value: ALL, label: 'All projects' },
              ...(projects.data?.projects ?? []).map((p) => ({ value: p.project, label: shortProject(p.project) })),
              ...(project && !projects.data?.projects.some((p) => p.project === project)
                ? [{ value: project, label: shortProject(project) }]
                : []),
            ]}
            className="w-52"
          />
          <SegmentedControl
            label="Range"
            value={sel ? ('' as Range) : range}
            onChange={(v) => set({ range: v, from: undefined, to: undefined })}
            options={RANGES.map((r) => ({ value: r, label: r === 'all' ? 'All' : r }))}
          />
        </div>
      </header>

      {sel && (
        <div className="flex items-center gap-2 text-sec text-muted">
          <span>
            Showing <b className="font-medium text-fg">{windowCaption(range, sel, dayText)}</b>; the chart still shows
            the whole range.
          </span>
          <Button size="sm" variant="ghost" onClick={() => set({ from: undefined, to: undefined })}>
            <X size={12} aria-hidden /> Clear
          </Button>
        </div>
      )}

      {empty ? (
        <Card>
          <EmptyState title="No spend in this range">
            Nothing was spent {project ? `in ${shortProject(project)} ` : ''}
            {sel ? 'on that day' : range === 'all' ? 'yet' : `in the last ${range.replace('d', '')} days`}. A longer
            range or another project may have some.
            {range !== 'all' && (
              <div className="mt-3">
                <Button onClick={() => set({ range: 'all', from: undefined, to: undefined })}>Show all time</Button>
              </div>
            )}
          </EmptyState>
        </Card>
      ) : (
        <>
          <Headline query={head} caption={windowCaption(range, sel, dayText)} />

          <Card
            title="By day"
            actions={
              <SegmentedControl
                label="Stack by"
                value={stack}
                onChange={(v) => set({ stack: v === 'model' ? undefined : v })}
                options={[
                  { value: 'model', label: 'By model' },
                  { value: 'source', label: 'Reported / attributed', title: 'Stack by where the figure comes from' },
                ]}
              />
            }
          >
            <QueryBoundary query={days} skeleton={<Skeleton className="h-56" />}>
              {(d) => (
                <ChartBody
                  rows={d.rows}
                  range={range}
                  win={chartWin}
                  stack={stack}
                  selected={sel}
                  onPick={(b) => set({ from: b.key, to: b.to })}
                />
              )}
            </QueryBoundary>
          </Card>

          <div className="grid grid-cols-2 items-start gap-4">
            <Card title="By project" flush>
              <CutTable
                query={byProject}
                name="Project"
                label={(r) => <ProjectName path={r.key} />}
                onPick={(r) => set({ project: r.key })}
                selected={project}
              />
            </Card>
            <div className="space-y-4">
              <Card title="By model" flush>
                <CutTable
                  query={byModel}
                  name="Model"
                  label={(r) =>
                    r.key === OVERHEAD ? (
                      <span title="Spend Claude Code reported that no transcript message explains.">
                        (overhead)<sup className="ml-0.5 text-faint">1</sup>
                      </span>
                    ) : (
                      <span title={r.key}>{modelLabel(r.key)}</span>
                    )
                  }
                  footer={(d) =>
                    d.rows.some((r) => r.key === OVERHEAD) && (
                      <>
                        <sup>1</sup> (overhead) is spend Claude Code reported that no transcript message explains. It
                        has no model of its own.
                      </>
                    )
                  }
                />
              </Card>
              <Card title="By kind" flush>
                <CutTable
                  query={byKind}
                  name="Kind"
                  label={(r) => (
                    <span title={r.label}>{r.key === 'sdk' ? 'sdk (scripted runs with spend)' : r.key}</span>
                  )}
                />
              </Card>
            </div>
          </div>
          <div>
            <Card
              title="Top sessions"
              flush
              actions={
                <span className="text-sec text-muted">Sessions last active in this range, with their whole cost</span>
              }
            >
              <TopSessions query={top} />
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

function Headline({ query, caption }: { query: CutQuery; caption: string }) {
  return (
    <Card>
      <QueryBoundary query={query} skeleton={<Skeleton className="h-16" />}>
        {(d) => {
          const { totalUSD, reportedUSD, attributedUSD } = d.total
          return (
            <div className="grid items-center gap-x-10 gap-y-3 grid-cols-[auto_1fr]">
              <div>
                <div className="text-sec text-muted">{caption}</div>
                <div className="text-page" data-testid="total">
                  <Money usd={totalUSD} />
                </div>
              </div>
              <div className="min-w-0 space-y-1.5">
                <Bar
                  height={8}
                  label="Reported versus attributed"
                  segments={[
                    { value: reportedUSD, tone: 'reported', title: 'Reported by Claude Code' },
                    { value: attributedUSD, tone: 'attributed', title: 'Attributed from token counts' },
                  ]}
                />
                <div className="flex flex-wrap gap-x-6 gap-y-0.5 text-sec">
                  <Source tone="reported" name="Reported" usd={reportedUSD} note="Claude Code's own figure" />
                  <Source tone="attributed" name="Attributed" usd={attributedUSD} note="recomputed from token counts" />
                </div>
                <div className="text-sec text-muted">{backingSentence(d.backing)}</div>
              </div>
            </div>
          )
        }}
      </QueryBoundary>
    </Card>
  )
}

function Source({
  tone,
  name,
  usd,
  note,
}: {
  tone: 'reported' | 'attributed'
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
  range,
  win,
  stack,
  selected,
  onPick,
}: {
  rows: CostRow[]
  range: Range
  win: ReturnType<typeof rangeWindow>
  stack: 'model' | 'source'
  selected: ReturnType<typeof selectedWindow>
  onPick: (b: Bucket) => void
}) {
  const buckets = useMemo(() => bucketsFor(rows, win, range), [rows, win, range])
  const top = useMemo(() => topModels(buckets), [buckets])
  const legend = useMemo(() => legendOf(buckets, stack, top), [buckets, stack, top])
  const weekly = buckets[0]?.weekly
  if (buckets.length === 0) return <EmptyState title="No days in this range" />
  const selKey = selected
    ? buckets.find((b) => b.key <= (selected.since ?? '') && (selected.since ?? '') <= b.to)?.key
    : undefined
  return (
    <div className="space-y-2">
      <DayChart buckets={buckets} stack={stack} top={top} selected={selKey} onSelect={onPick} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sec text-muted">
        {legend.map((l) => (
          <span key={l.key} className="inline-flex items-center gap-1.5">
            <Swatch tone={l.tone} />
            {segmentLabel(l.key)}
          </span>
        ))}
        {weekly && <span className="ml-auto text-faint">One bar per week (Mon to Sun)</span>}
      </div>
    </div>
  )
}

function legendOf(buckets: Bucket[], stack: 'model' | 'source', top: string[]) {
  const seen = new Map<string, ReturnType<typeof modelTone>>()
  for (const b of buckets) for (const s of stackOf(b, stack, top)) seen.set(s.key, s.tone)
  const order = stack === 'source' ? ['reported', 'attributed'] : [...top, 'other', OVERHEAD]
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
            cell: (r) => <Money usd={r.totalUSD} />,
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

function TopSessions({ query }: { query: CutQuery }) {
  return (
    <QueryBoundary
      query={query}
      skeleton={<SkeletonRows rows={6} height={32} />}
      empty={<EmptyState title="No sessions in this range" />}
      isEmpty={(d) => d.rows.length === 0}
    >
      {(d) => {
        const columns: Column<CostRow>[] = [
          {
            key: 'title',
            header: 'Session',
            cell: (r) =>
              r.key.startsWith('scripted:') ? (
                <span title="Scripted runs are only shown in aggregate">{r.label ?? r.key}</span>
              ) : (
                <Link
                  to={sessionPath({ harness: r.harness ?? 'claude', id: r.key })}
                  className="block max-w-[60ch] truncate"
                  title={r.label ?? r.key}
                >
                  {r.label || r.key.slice(0, 8)}
                </Link>
              ),
          },
          {
            key: 'project',
            header: 'Project',
            cell: (r) => {
              const p = r.project ?? (r.key.startsWith('scripted:') ? r.key.slice('scripted:'.length) : undefined)
              return p ? <ProjectName path={p} className="text-muted" /> : <span className="text-faint">–</span>
            },
          },
          {
            key: 'at',
            header: 'Last activity',
            cell: (r) =>
              r.lastActivityAt ? (
                <RelTime time={r.lastActivityAt} className="text-muted" />
              ) : (
                <span className="text-faint">–</span>
              ),
          },
          {
            key: 'total',
            header: 'Cost',
            align: 'right',
            width: '110px',
            cell: (r) => <Money usd={r.totalUSD} flag={r.flag} />,
          },
        ]
        return (
          <DataTable
            columns={columns}
            rows={d.rows}
            rowKey={(r) => r.key}
            rowHref={(r) => (r.key.startsWith('scripted:') ? undefined : sessionPath({ harness: 'claude', id: r.key }))}
            stickyTop={0}
            footer={
              d.truncated
                ? `The 50 largest of ${formatCount(d.sessions)} sessions (scripted runs counted as ${formatCount(d.backing.scriptedRuns)}).`
                : undefined
            }
          />
        )
      }}
    </QueryBoundary>
  )
}
