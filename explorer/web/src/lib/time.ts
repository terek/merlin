// Time formatting in the viewer's local time zone. English month and day names, 24 h clock, so
// the output does not depend on the browser's locale.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const pad = (n: number) => String(n).padStart(2, '0')

/** Parses an API timestamp; undefined for a missing or invalid one. */
export function parseTime(s: string | undefined): Date | undefined {
  if (!s) return undefined
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/** The local calendar day as "2026-09-16" (the form `?since=` takes and cost rows use). */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local day of an API timestamp; "" when it has none. */
export function localDayOf(s: string | undefined): string {
  const d = parseTime(s)
  return d ? localDay(d) : ''
}

/** "2026-09-16" -> local midnight of that day. */
export function dayStart(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** The local day `n` days before `d` (calendar arithmetic, so it holds across DST changes). */
export function daysBefore(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n)
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

const FUTURE_SLACK_MS = -3_600_000

/**
 * Relative time as the lists write it: "just now", "3 min ago", "2 h ago", "yesterday 14:02",
 * "12 Sep", and "12 Sep 2025" in another year. Under an hour it is always minutes, also across
 * midnight (00:10 after 23:50 is "20 min ago", not "yesterday"). A time up to an hour ahead of
 * `now` reads "just now".
 */
export function relTime(then: Date, now: Date = new Date()): string {
  const diff = now.getTime() - then.getTime()
  // a little in the future is clock skew (or a mock anchored on the hour), not a date
  if (diff < 45_000 && diff >= FUTURE_SLACK_MS) return 'just now'
  if (diff >= 0 && diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} min ago`
  if (diff >= 0 && sameDay(then, now)) return `${Math.floor(diff / 3_600_000)} h ago`
  if (sameDay(then, daysBefore(now, 1))) return `yesterday ${hhmm(then)}`
  return shortDate(then, now)
}

/** "12 Sep", or "12 Sep 2025" when `d` is not in the year of `now`. */
export function shortDate(d: Date, now: Date = new Date()): string {
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`
}

/** For tooltips: "Wed 16 Sep 2026, 10:00:08". */
export function fullTime(d: Date): string {
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hhmm(d)}:${pad(d.getSeconds())}`
}

/** "10:00" local time of day. */
export function timeOfDay(d: Date): string {
  return hhmm(d)
}

/** Heading of a day group: "Today", "Yesterday", "Mon 14 Sep", "Mon 14 Sep 2025". */
export function dayLabel(d: Date, now: Date = new Date()): string {
  if (sameDay(d, now)) return 'Today'
  if (sameDay(d, daysBefore(now, 1))) return 'Yesterday'
  return `${DAYS[d.getDay()]} ${shortDate(d, now)}`
}

/** Same as dayLabel for a "2026-09-16" key. */
export function dayLabelOf(day: string, now: Date = new Date()): string {
  return dayLabel(dayStart(day), now)
}

/** Length of a wall-clock stretch in ms, or undefined when either end is missing. */
export function spanMs(from: string | undefined, to: string | undefined): number | undefined {
  const a = parseTime(from)
  const b = parseTime(to)
  return a && b ? Math.max(0, b.getTime() - a.getTime()) : undefined
}
