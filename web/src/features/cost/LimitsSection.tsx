// The Limits section of the Cost page (docs/ui.md section 10): the subscription windows in the scope that ran out or
// came close, newest first, and what each was spent on. A row narrows the scope to its window; its "sessions" link opens
// the Overview on the same window.

import { Link } from 'react-router-dom'
import type { LimitLockout, LimitWindow } from '../../api/types'
import { cn } from '../../lib/cn'
import { formatMoney } from '../../lib/format'
import { HarnessIcon, Money } from '../../ui'
import { openValue } from '../overview/focus'
import { type CustomRange, formatCustom } from '../overview/model'
import { episodeText, limitName, windowLockouts, windowRange, windowTimes } from '../overview/windows'
import { sessionLabel, worthSentences } from './worth'

const HEAD = 'text-faint text-meta uppercase tracking-wide'

/**
 * The Overview's address for a window: its instants and harness, the spend sort, the current place kept; with
 * `open`, that session open in it.
 */
export function windowSessionsHref(
  sp: URLSearchParams,
  r: CustomRange,
  open?: { harness: string; id: string },
): string {
  const out = new URLSearchParams()
  for (const k of ['by', 'in']) {
    const v = sp.get(k)
    if (v) out.set(k, v)
  }
  const f = formatCustom(r)
  if (f) for (const [k, v] of Object.entries(f)) if (v) out.set(k, v)
  out.set('sort', 'spend')
  if (open) out.set('open', openValue(open))
  return `/?${out.toString()}`
}

export function Limits({
  windows,
  lockouts,
  sp,
  onWindow,
  fromMs,
  toMs,
}: {
  /** The qualifying windows overlapping the scope, newest first (`scopeWindows`). */
  windows: readonly LimitWindow[]
  lockouts: readonly LimitLockout[]
  sp: URLSearchParams
  onWindow: (r: CustomRange) => void
  fromMs: number
  toMs: number
}) {
  const from = fromMs
  const to = toMs
  const unmatched = lockouts.filter(
    (l) =>
      !windows.some((w) => windowLockouts(w, [l]).length > 0) &&
      (!sp.get('harness') || sp.get('harness') === l.harness) &&
      (!sp.get('account') || sp.get('account') === (l.account ?? 'unknown')) &&
      (!Number.isFinite(from) ||
        Date.parse(l.endedAt ?? '') >= from ||
        (l.end === 'open' && Date.parse(l.startedAt) <= Date.now())) &&
      (!Number.isFinite(to) || Date.parse(l.startedAt) < to),
  )
  if (windows.length === 0 && unmatched.length === 0) return null
  const sentences = worthSentences(windows)
  return (
    <section className="border-line border-b">
      <div className="flex min-h-9 items-center px-4 pt-2">
        <h2 className={HEAD}>Limits</h2>
      </div>
      <div className="px-4 pt-1 pb-3">
        <table className="w-full table-fixed text-sec">
          <thead>
            <tr className={cn(HEAD, 'h-9')}>
              <th className="w-[32%] text-left font-normal">Window</th>
              <th className="w-14 text-right font-normal">Used</th>
              <th className="w-[24%] px-2 text-right font-normal">Account lockout</th>
              <th className="w-24 text-right font-normal">Spent</th>
              <th className="px-4 text-left font-normal">Biggest sessions</th>
              <th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {windows.map((w) => (
              <Row
                key={`${w.harness}/${w.account}/${w.plan}/${w.planPeriod}/${w.kind}/${w.windowMinutes}/${w.limit}/${w.resetsAt}`}
                w={w}
                lockouts={windowLockouts(w, lockouts)}
                sp={sp}
                onWindow={onWindow}
              />
            ))}
          </tbody>
        </table>
        {unmatched.map((l) => (
          <p
            key={`${l.harness}/${l.account}/${l.kind}/${l.windowMinutes}/${l.limit}/${l.startedAt}`}
            className="pt-2 text-meta text-muted"
          >
            <span className="text-fg">{limitName(l)}</span> · {episodeText(l)}
            {l.resetsAt && <span> · reset {new Date(l.resetsAt).toLocaleString()}</span>}
          </p>
        ))}
        {sentences.map((s) => (
          <p key={s} className="pt-1 text-meta text-muted">
            {s}
          </p>
        ))}
      </div>
    </section>
  )
}

function Row({
  w,
  lockouts,
  sp,
  onWindow,
}: {
  w: LimitWindow
  lockouts: LimitLockout[]
  sp: URLSearchParams
  onWindow: (r: CustomRange) => void
}) {
  const claude = w.harness === 'claude'
  const range = w.startsAt ? windowRange(w) : undefined
  const scripted = w.scriptedUSD ?? 0
  const approx = claude
  return (
    <tr
      className={cn('h-[34px] border-line border-t', range && 'cursor-pointer hover:bg-surface-2')}
      title={range ? 'Scope to this limit window' : 'Window bounds unknown'}
      onClick={() => range && onWindow(range)}
    >
      <td className="min-w-0 py-1">
        <div className="flex items-center gap-1.5 truncate">
          <HarnessIcon harness={w.harness} size={14} />
          <span className="text-fg">{limitName(w)}</span>
          {w.accountLabel && <span className="text-muted">{w.accountLabel}</span>}
          {w.plan && <span className="text-muted">{w.plan}</span>}
          {range && (
            <span className="truncate text-muted" title={windowTimes(w)}>
              {approx ? '≈ ' : ''}
              {windowTimes(w)}
            </span>
          )}
        </div>
        {!range && <div className="text-meta text-muted">{windowTimes(w)}</div>}
      </td>
      <td className="text-right">
        {claude ? (
          <span className="text-bad">hit</span>
        ) : (
          <span className={cn((w.maxPercent ?? 0) >= 100 && 'font-semibold text-bad')}>
            {Math.round(w.maxPercent ?? 0)}%
          </span>
        )}
      </td>
      <td className="px-2 text-right">
        {lockouts.length === 0 ? (
          <span className="text-faint">–</span>
        ) : (
          lockouts.map((l) => (
            <div key={l.startedAt} title={episodeText(l)}>
              {episodeText({ ...l, accountLabel: undefined })}
            </div>
          ))
        )}
      </td>
      <td
        className="text-right"
        title={w.usdPerPercent ? `1% ≈ ${formatMoney(w.usdPerPercent)} in this window` : undefined}
      >
        {w.seenUSD === undefined ? (
          <span className="text-faint">–</span>
        ) : (
          <>
            {claude && <span className="text-muted">≥ </span>}
            <Money usd={w.seenUSD} />
          </>
        )}
      </td>
      <td className="min-w-0 px-4">
        <div className="truncate">
          {(w.topSessions ?? []).map((s, i) => (
            <span key={`${s.harness}/${s.id}`}>
              {i > 0 && ', '}
              <Link
                to={range ? windowSessionsHref(sp, range, s) : `/?open=${openValue(s)}`}
                onClick={(e) => e.stopPropagation()}
                className="text-fg hover:text-accent hover:underline"
                title={`${sessionLabel(s)}: ${s.usd.toFixed(2)} USD`}
              >
                {sessionLabel(s)}
              </Link>
            </span>
          ))}
          {scripted > 0 && (
            <span className="text-muted">
              {(w.topSessions?.length ?? 0) > 0 ? ' ' : ''}+ scripted <Money usd={scripted} dim />
            </span>
          )}
        </div>
      </td>
      <td className="text-right">
        {range && (
          <Link
            to={windowSessionsHref(sp, range)}
            onClick={(e) => e.stopPropagation()}
            className="text-muted hover:text-accent"
          >
            sessions →
          </Link>
        )}
      </td>
    </tr>
  )
}
