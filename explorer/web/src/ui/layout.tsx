import { ArrowDown, ArrowUp } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '../lib/cn'
import { share } from '../lib/format'

/** A bordered surface with an optional title row (title left, `actions` right). */
export function Card({
  title,
  actions,
  children,
  className,
  bodyClassName,
  flush,
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  /** No padding around the body (a table that runs edge to edge). */
  flush?: boolean
}) {
  return (
    <section className={cn('rounded-card border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex min-h-9 items-center justify-between gap-3 border-b border-line px-3 py-1.5">
          <h2 className="text-body font-semibold">{title}</h2>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn(!flush && 'p-3', bodyClassName)}>{children}</div>
    </section>
  )
}

/** A titled block without a border (a section of a page). */
export function Section({
  title,
  actions,
  hint,
  children,
  className,
}: {
  title: ReactNode
  actions?: ReactNode
  /** A line of secondary text under the title. */
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('space-y-2', className)}>
      <header className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-title font-semibold">{title}</h2>
          {hint && <p className="text-sec text-muted">{hint}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  )
}

export type BarTone =
  | 'reported'
  | 'attributed'
  | 'overhead'
  | 'accent'
  | 'ok'
  | 'warn'
  | 'bad'
  | 'muted'
  | 'series-1'
  | 'series-2'
  | 'series-3'
  | 'series-4'
  | 'series-5'
  | 'series-other'

const BAR_BG: Record<BarTone, string> = {
  reported: 'bg-reported',
  attributed: 'bg-attributed',
  overhead: 'bg-overhead',
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
  muted: 'bg-faint',
  'series-1': 'bg-series-1',
  'series-2': 'bg-series-2',
  'series-3': 'bg-series-3',
  'series-4': 'bg-series-4',
  'series-5': 'bg-series-5',
  'series-other': 'bg-series-other',
}

export interface BarSegment {
  value: number
  tone: BarTone
  /** Tooltip of the segment. */
  title?: string
}

/**
 * A horizontal proportion bar with one or more coloured segments. Widths are `value / total`
 * (total defaults to the sum, so segments fill the bar; pass the session total to show a share).
 * A non-zero segment is never thinner than 2 px.
 */
export function Bar({
  segments,
  total,
  height = 6,
  className,
  label,
}: {
  segments: BarSegment[]
  total?: number
  height?: number
  className?: string
  label?: string
}) {
  const sum = segments.reduce((a, s) => a + Math.max(0, s.value), 0)
  const whole = Math.max(total ?? sum, sum)
  return (
    <div
      role="img"
      aria-label={label}
      className={cn('flex w-full overflow-hidden rounded-full bg-surface-2', className)}
      style={{ height }}
    >
      {segments.map(
        (s, i) =>
          s.value > 0 && (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
              key={i}
              title={s.title}
              className={cn('h-full min-w-0.5', BAR_BG[s.tone])}
              style={{ width: `${share(s.value, whole) * 100}%` }}
            />
          ),
      )}
    </div>
  )
}

export interface Column<T> {
  key: string
  header: ReactNode
  cell: (row: T, index: number) => ReactNode
  align?: 'left' | 'right'
  /** CSS width of the column ("120px", "40%"). */
  width?: string
  /** Makes the column sortable by clicking its header. */
  sortValue?: (row: T) => number | string
  headerTitle?: string
  className?: string
}

export interface SortState {
  key: string
  dir: 'asc' | 'desc'
}

/**
 * A plain table: sticky header, right-aligned numeric columns, optional row link. Columns with
 * `sortValue` sort on click (`defaultSort` to start sorted; or control it with `sort` and
 * `onSortChange`). A row with `rowHref` is clickable (cmd / ctrl-click opens a new tab); put a
 * real `<Link>` in its first cell so that it can be reached with the keyboard.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowHref,
  onRowClick,
  selectedKey,
  rowClassName,
  defaultSort,
  sort: controlledSort,
  onSortChange,
  empty,
  stickyTop = 44,
  className,
  footer,
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  rowHref?: (row: T) => string | undefined
  onRowClick?: (row: T) => void
  selectedKey?: string
  rowClassName?: (row: T) => string | undefined
  defaultSort?: SortState
  sort?: SortState
  onSortChange?: (s: SortState) => void
  empty?: ReactNode
  /** Distance of the sticky header from the top of the viewport (the top bar is 44px). */
  stickyTop?: number
  className?: string
  footer?: ReactNode
}) {
  const navigate = useNavigate()
  const [own, setOwn] = useState<SortState | undefined>(defaultSort)
  const sort = controlledSort ?? own
  const sorted = useMemo(() => {
    const col = sort && columns.find((c) => c.key === sort.key)
    if (!col?.sortValue) return rows
    const val = col.sortValue
    const dir = sort?.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const x = val(a)
      const y = val(b)
      return (x < y ? -1 : x > y ? 1 : 0) * dir
    })
  }, [rows, columns, sort])

  const toggle = (c: Column<T>) => {
    if (!c.sortValue) return
    const next: SortState = {
      key: c.key,
      dir: sort?.key === c.key && sort?.dir === 'desc' ? 'asc' : 'desc',
    }
    if (!controlledSort) setOwn(next)
    onSortChange?.(next)
  }

  return (
    <table className={cn('w-full border-separate border-spacing-0 text-body', className)}>
      <thead>
        <tr>
          {columns.map((c) => {
            const active = sort?.key === c.key
            return (
              <th
                key={c.key}
                scope="col"
                title={c.headerTitle}
                aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                style={{ width: c.width, top: stickyTop }}
                className={cn(
                  'sticky z-10 h-8 whitespace-nowrap border-b border-line bg-surface px-3 text-sec font-medium text-muted',
                  c.align === 'right' ? 'text-right' : 'text-left',
                )}
              >
                {c.sortValue ? (
                  <button
                    type="button"
                    onClick={() => toggle(c)}
                    className={cn(
                      'inline-flex items-center gap-1 hover:text-fg',
                      c.align === 'right' && 'flex-row-reverse',
                      active && 'text-fg',
                    )}
                  >
                    {c.header}
                    {active &&
                      (sort?.dir === 'asc' ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />)}
                  </button>
                ) : (
                  c.header
                )}
              </th>
            )
          })}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row, i) => {
          const href = rowHref?.(row)
          const k = rowKey(row)
          const clickable = !!href || !!onRowClick
          return (
            <tr
              key={k}
              aria-selected={selectedKey === k || undefined}
              onClick={
                clickable
                  ? (e) => {
                      if ((e.target as HTMLElement).closest('a,button,input,select')) return
                      if (href) {
                        if (e.metaKey || e.ctrlKey) window.open(href, '_blank', 'noreferrer')
                        else navigate(href)
                      }
                      onRowClick?.(row)
                    }
                  : undefined
              }
              className={cn(
                'group',
                clickable && 'cursor-pointer hover:bg-surface-2',
                selectedKey === k && 'bg-accent-soft',
                rowClassName?.(row),
              )}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    'h-8 border-b border-line px-3 align-middle',
                    c.align === 'right' ? 'text-right' : 'text-left',
                    c.className,
                  )}
                >
                  {c.cell(row, i)}
                </td>
              ))}
            </tr>
          )
        })}
        {sorted.length === 0 && empty && (
          <tr>
            <td colSpan={columns.length} className="p-0">
              {empty}
            </td>
          </tr>
        )}
      </tbody>
      {footer && (
        <tfoot>
          <tr>
            <td colSpan={columns.length} className="px-3 py-2 text-sec text-muted">
              {footer}
            </td>
          </tr>
        </tfoot>
      )}
    </table>
  )
}
