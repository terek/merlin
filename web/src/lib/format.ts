// Number formatting. Pure functions; the components in src/ui are thin wrappers over them.

const countFmt = new Intl.NumberFormat('en-US')
const moneyBig = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const moneySmall = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 1234567 -> "1,234,567". */
export function formatCount(n: number): string {
  return countFmt.format(Math.round(n))
}

/**
 * A dollar figure by the rules of docs/ui.md: zero is "$0"; under one cent "<$0.01"; under $100
 * two decimals; from $100 no decimals and thousands separators. The rule looks at the value, so
 * 0.0096 is "<$0.01" although it would round to a cent, and 99.996 is "$100".
 */
export function formatMoney(usd: number): string {
  if (!Number.isFinite(usd)) return '$?'
  if (usd < 0) return `-${formatMoney(-usd)}`
  if (usd === 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 99.995) return `$${moneySmall.format(usd)}`
  return `$${moneyBig.format(usd)}`
}

/** The full figure for a tooltip: "$0.014100", "$1,234.5678". */
export function formatMoneyFull(usd: number): string {
  if (!Number.isFinite(usd)) return '$?'
  const sign = usd < 0 ? '-' : ''
  const abs = Math.abs(usd)
  const [int, frac] = abs.toFixed(6).split('.')
  return `${sign}$${countFmt.format(Number(int))}.${frac}`
}

/** 812 -> "812", 12345 -> "12.3k", 1234567 -> "1.2M". Trailing ".0" is dropped. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '?'
  if (n < 0) return `-${formatTokens(-n)}`
  if (n < 1000) return String(Math.round(n))
  // Thresholds are where one decimal rounds up to the next unit (999.95k -> 1.0M).
  if (n < 999_950) return `${trim1(n / 1000)}k`
  if (n < 999_950_000) return `${trim1(n / 1_000_000)}M`
  return `${trim1(n / 1_000_000_000)}B`
}

function trim1(x: number): string {
  return x.toFixed(1).replace(/\.0$/, '')
}

/** 850 -> "850 ms", 12000 -> "12 s", 245000 -> "4 min 05 s", 7980000 -> "2 h 13 min". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  if (Math.round(ms) < 1000) return `${Math.round(ms)} ms`
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total} s`
  const pad = (n: number) => String(n).padStart(2, '0')
  if (total < 3600) return `${Math.floor(total / 60)} min ${pad(total % 60)} s`
  return `${Math.floor(total / 3600)} h ${pad(Math.floor((total % 3600) / 60))} min`
}

/** 0.256 -> "26%"; below half a percent of a non-zero part "<1%". */
export function formatPercent(part: number, whole: number): string {
  if (!(whole > 0) || !(part > 0)) return '0%'
  const p = (part / whole) * 100
  if (p < 0.5) return '<1%'
  return `${Math.round(p)}%`
}

/** part / whole clamped to 0..1; 0 when whole is not positive. */
export function share(part: number, whole: number): number {
  if (!(whole > 0) || !(part > 0)) return 0
  return Math.min(1, part / whole)
}

/** Plural helper: plural(1, 'turn') -> "1 turn", plural(2, 'turn') -> "2 turns". */
export function plural(n: number, word: string, pluralForm = `${word}s`): string {
  return `${formatCount(n)} ${n === 1 ? word : pluralForm}`
}
