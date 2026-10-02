// The small components that write numbers and times the same way everywhere.

import type { CostFlag } from '../api/types'
import { cn } from '../lib/cn'
import { flagExplanation, flagMarkers } from '../lib/cost'
import { formatCount, formatDuration, formatMoney, formatMoneyFull, formatTokens } from '../lib/format'
import { useNow } from '../lib/hooks'
import { fullTime, parseTime, relTime } from '../lib/time'

/**
 * Every dollar figure in the app. Under $0.01 `<$0.01`, under $100 two decimals, from $100 none;
 * zero is a faint `$0`. `flag` adds the marker (`~` estimated, `+est` partial) and a tooltip that
 * explains it; without a flag the tooltip is the full figure. Never pass a flag for a figure
 * that is not session level (a turn or an agent is attributed: say so once per panel).
 */
export function Money({
  usd,
  flag,
  dim,
  className,
  title,
}: {
  usd: number
  flag?: CostFlag
  /** Muted instead of the text colour. */
  dim?: boolean
  className?: string
  /** Replaces the default tooltip. */
  title?: string
}) {
  const { prefix, suffix } = flagMarkers(flag)
  const zero = usd === 0
  const explain = flagExplanation(flag)
  const tip = title ?? (explain ? `${formatMoneyFull(usd)}\n${explain}` : formatMoneyFull(usd))
  return (
    <span
      className={cn('font-mono whitespace-nowrap', zero ? 'text-faint' : dim ? 'text-muted' : 'text-fg', className)}
      title={tip}
    >
      {prefix}
      {formatMoney(usd)}
      {suffix && <span className="ml-0.5 text-meta text-faint">{suffix}</span>}
    </span>
  )
}

/** A token count: `812`, `12.3k`, `1.2M`; the tooltip has the exact number. */
export function Tokens({ n, className, dim }: { n: number; className?: string; dim?: boolean }) {
  return (
    <span
      className={cn('font-mono whitespace-nowrap', n === 0 ? 'text-faint' : dim ? 'text-muted' : 'text-fg', className)}
      title={`${formatCount(n)} tokens`}
    >
      {formatTokens(n)}
    </span>
  )
}

/** A time relative to now ("3 min ago"); the tooltip has the full local time. Re-renders each minute. */
export function RelTime({ time, className }: { time: string | Date | undefined; className?: string }) {
  const now = useNow()
  const d = typeof time === 'string' || time === undefined ? parseTime(time) : time
  if (!d) return <span className={cn('text-faint', className)}>{'–'}</span>
  return (
    <time dateTime={d.toISOString()} title={fullTime(d)} className={cn('whitespace-nowrap', className)}>
      {relTime(d, now)}
    </time>
  )
}

/** A duration: `850 ms`, `12 s`, `4 min 05 s`, `2 h 13 min`. */
export function Duration({ ms, className }: { ms: number | undefined; className?: string }) {
  if (ms === undefined) return <span className={cn('text-faint', className)}>{'–'}</span>
  return (
    <span className={cn('whitespace-nowrap', className)} title={`${formatCount(ms)} ms`}>
      {formatDuration(ms)}
    </span>
  )
}
