// The Overview page's pure logic: the shared time axis with its breaks, the shared scales, row
// heights, sorting, the glyphs of a row's events, and which sessions a clicked slot lists.
// OverviewPage.tsx draws what this returns (docs/ui.md section 10b).

import type { Overview, OverviewEvent, OverviewGroup, OverviewLane, OverviewSlot } from '../../api/types'

const HOUR = 3_600_000
const DAY = 24 * HOUR

export type Range = '1d' | '7d' | '30d'
export type SortKey = 'spend' | 'sessions' | 'priciest' | 'recent'
export type CtxMode = 'sum' | 'peak'

export const RANGES: Record<Range, { ms: number; slot: OverviewSlot; breakMs: number }> = {
  '1d': { ms: DAY, slot: '15m', breakMs: HOUR },
  '7d': { ms: 7 * DAY, slot: '1h', breakMs: 4 * HOUR },
  '30d': { ms: 30 * DAY, slot: '6h', breakMs: DAY },
}

/** Width of a squeezed break, in px. */
export const BREAK_W = 26

// ---- axis ------------------------------------------------------------------------------

export interface AxisSegment {
  kind: 'slots' | 'break'
  /** Slot indexes, `from` inclusive, `to` exclusive. */
  from: number
  to: number
  x0: number
  x1: number
}

export interface Axis {
  width: number
  slots: number
  slotW: number
  segments: AxisSegment[]
  /** Left edge of slot i; a slot inside a break maps to the break's left edge. */
  x: number[]
  /** Whether slot i is drawn (false inside a break). */
  shown: boolean[]
}

/**
 * Lays the slots out across `width` px. `quiet[i]` is true when nothing at all ran in slot i; a run
 * of quiet slots longer than `breakMs` becomes a break of BREAK_W px, the rest share what is left.
 */
export function buildAxis(quiet: boolean[], slotMs: number, breakMs: number, width: number): Axis {
  const n = quiet.length
  const runs: { kind: 'slots' | 'break'; from: number; to: number }[] = []
  let i = 0
  while (i < n) {
    let j = i
    while (j < n && quiet[j] === quiet[i]) j++
    const isBreak = quiet[i] && (j - i) * slotMs > breakMs && !(i === 0 && j === n)
    const last = runs[runs.length - 1]
    if (last && last.kind === (isBreak ? 'break' : 'slots')) last.to = j
    else runs.push({ kind: isBreak ? 'break' : 'slots', from: i, to: j })
    i = j
  }
  const breaks = runs.filter((r) => r.kind === 'break').length
  const shownSlots = runs.reduce((a, r) => (r.kind === 'slots' ? a + r.to - r.from : a), 0)
  const slotW = shownSlots > 0 ? Math.max(0, (width - breaks * BREAK_W) / shownSlots) : 0
  const segments: AxisSegment[] = []
  const x = new Array<number>(n + 1).fill(0)
  const shown = new Array<boolean>(n).fill(true)
  let cx = 0
  for (const r of runs) {
    const w = r.kind === 'break' ? BREAK_W : (r.to - r.from) * slotW
    segments.push({ ...r, x0: cx, x1: cx + w })
    for (let k = r.from; k < r.to; k++) {
      x[k] = r.kind === 'break' ? cx : cx + (k - r.from) * slotW
      shown[k] = r.kind !== 'break'
    }
    cx += w
  }
  x[n] = cx
  return { width: cx, slots: n, slotW, segments, x, shown }
}

/** The slot under pixel x, or -1 inside a break or outside the plot. */
export function slotAt(axis: Axis, px: number): number {
  if (px < 0 || px >= axis.width) return -1
  for (const s of axis.segments) {
    if (px < s.x0 || px >= s.x1) continue
    if (s.kind === 'break' || axis.slotW <= 0) return -1
    return Math.min(s.to - 1, s.from + Math.floor((px - s.x0) / axis.slotW))
  }
  return -1
}

/** Slots in which nothing ran anywhere: no group active or spending, no scripted spend. */
export function quietSlots(o: Pick<Overview, 'slots' | 'groups' | 'scripted'>): boolean[] {
  const out = new Array<boolean>(o.slots).fill(true)
  for (let i = 0; i < o.slots; i++) {
    if ((o.scripted.usdSlots[i] ?? 0) > 0) out[i] = false
  }
  for (const g of o.groups) {
    for (let i = 0; i < o.slots; i++) {
      if ((g.active[i] ?? 0) > 0 || (g.usdSlots[i] ?? 0) > 0) out[i] = false
    }
  }
  return out
}

export function breakLabel(ms: number): string {
  const h = Math.round(ms / HOUR)
  return h < 48 ? `${h} h` : `${Math.round(ms / DAY)} d`
}

export interface Tick {
  x: number
  label: string
  /** A midnight (the others are the hours inside a day). */
  day: boolean
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Midnight ticks with day labels (and 6-hourly ticks at 15 min slots); labels thinned to `minGap` px. */
export function axisTicks(axis: Axis, fromMs: number, slotMs: number, minGap = 54): Tick[] {
  const out: Tick[] = []
  let lastX = -Infinity
  for (let i = 0; i < axis.slots; i++) {
    if (!axis.shown[i]) continue
    const t = new Date(fromMs + i * slotMs)
    const midnight = t.getHours() === 0 && t.getMinutes() === 0
    const hourly = slotMs <= HOUR / 2 && t.getMinutes() === 0 && t.getHours() % 6 === 0
    if (!midnight && !hourly) continue
    const x = axis.x[i]
    if (x - lastX < minGap) continue
    lastX = x
    const hh = String(t.getHours()).padStart(2, '0')
    out.push({ x, day: midnight, label: midnight ? `${DAYS[t.getDay()]} ${t.getDate()}` : `${hh}:00` })
  }
  return out
}

/** Midnight x positions, for the faint day lines (not thinned). */
export function midnightXs(axis: Axis, fromMs: number, slotMs: number): number[] {
  const out: number[] = []
  for (let i = 0; i < axis.slots; i++) {
    if (!axis.shown[i]) continue
    const t = new Date(fromMs + i * slotMs)
    if (t.getHours() === 0 && t.getMinutes() === 0) out.push(axis.x[i])
  }
  return out
}

// ---- scales and heights ------------------------------------------------------------------

export interface Scales {
  /** px per token and px per dollar, the same for every row. */
  pxPerTok: number
  pxPerUsd: number
  maxTok: number
  maxUsd: number
}

export interface Heights {
  up: number
  down: number
}

export const MAX_UP = 56
export const MAX_DOWN = 38
export const MIN_SIDE = 5

export const contextOf = (g: OverviewGroup, mode: CtxMode): number[] => (mode === 'sum' ? g.contextSum : g.contextPeak)

const peakOf = (a: number[]): number => a.reduce((m, v) => (v > m ? v : m), 0)

/** One token scale and one dollar scale for all the rows: the largest value anywhere reaches the limit. */
export function scalesFor(groups: OverviewGroup[], mode: CtxMode, scripted?: number[]): Scales {
  let maxTok = 0
  let maxUsd = peakOf(scripted ?? [])
  for (const g of groups) {
    maxTok = Math.max(maxTok, peakOf(contextOf(g, mode)))
    maxUsd = Math.max(maxUsd, peakOf(g.usdSlots))
  }
  return { maxTok, maxUsd, pxPerTok: maxTok > 0 ? MAX_UP / maxTok : 0, pxPerUsd: maxUsd > 0 ? MAX_DOWN / maxUsd : 0 }
}

/** A row is as tall as its own peaks need on the shared scales; a minimum keeps a quiet row readable. */
export function rowHeights(ctx: number[], usd: number[], s: Scales, minSide = MIN_SIDE): Heights {
  return {
    up: Math.max(minSide, Math.round(peakOf(ctx) * s.pxPerTok)),
    down: Math.max(minSide, Math.round(peakOf(usd) * s.pxPerUsd)),
  }
}

/** The largest 1, 2 or 5 times a power of ten not above v (0 for v <= 0). */
export function niceFloor(v: number): number {
  if (!(v > 0)) return 0
  const p = 10 ** Math.floor(Math.log10(v))
  const m = v / p
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p
}

// ---- sorting -----------------------------------------------------------------------------

export function sortGroups(groups: OverviewGroup[], by: SortKey): OverviewGroup[] {
  const val = (g: OverviewGroup): number | string =>
    by === 'spend'
      ? g.usd
      : by === 'sessions'
        ? g.sessions
        : by === 'priciest'
          ? (g.priciest?.usd ?? 0)
          : (g.lastActivityAt ?? '')
  return [...groups].sort((a, b) => {
    const x = val(a)
    const y = val(b)
    if (x !== y) return x < y ? 1 : -1
    return a.usd !== b.usd ? b.usd - a.usd : a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
}

// ---- row marks ---------------------------------------------------------------------------

export interface ActivityRun {
  from: number
  to: number
  /** 1, 2 or 3 (three or more). */
  weight: 1 | 2 | 3
}

/** Contiguous slots with the same activity weight, for the line on the baseline. Not merged across breaks. */
export function activityRuns(active: number[], shown: boolean[]): ActivityRun[] {
  const out: ActivityRun[] = []
  for (let i = 0; i < active.length; i++) {
    if (!(active[i] > 0) || !shown[i]) continue
    const w = Math.min(3, active[i]) as 1 | 2 | 3
    const last = out[out.length - 1]
    if (last && last.to === i && last.weight === w) last.to = i + 1
    else out.push({ from: i, to: i + 1, weight: w })
  }
  return out
}

export interface SlotMarks {
  fork: number
  continuation: number
  agents: number
  cold: number
  warm: number
  /** A compaction of unknown temperature. */
  other: number
}

const noMarks = (): SlotMarks => ({ fork: 0, continuation: 0, agents: 0, cold: 0, warm: 0, other: 0 })

/** The events of a row folded into one record per slot. */
export function marksBySlot(events: OverviewEvent[] | undefined): Map<number, SlotMarks> {
  const out = new Map<number, SlotMarks>()
  for (const e of events ?? []) {
    let m = out.get(e.slot)
    if (!m) {
      m = noMarks()
      out.set(e.slot, m)
    }
    if (e.type === 'agent') m.agents += e.n
    else if (e.type === 'session') {
      if (e.kind === 'fork') m.fork += e.n
      else m.continuation += e.n
    } else if (e.type === 'compaction') {
      if (e.kind === 'cold') m.cold += e.n
      else if (e.kind === 'warm') m.warm += e.n
      else m.other += e.n
    }
  }
  return out
}

/** A slot's events in words ("3 agents launched, cold compaction"); '' when none. */
export function describeMarks(m: SlotMarks | undefined): string {
  if (!m) return ''
  const out: string[] = []
  if (m.agents) out.push(`${m.agents} agent${m.agents === 1 ? '' : 's'} launched`)
  if (m.fork) out.push(m.fork === 1 ? 'a session forked' : `${m.fork} sessions forked`)
  if (m.continuation) out.push(m.continuation === 1 ? 'a session continued' : `${m.continuation} sessions continued`)
  if (m.cold) out.push(`${m.cold > 1 ? `${m.cold} ` : ''}cold compaction${m.cold > 1 ? 's' : ''}`)
  if (m.warm) out.push(`${m.warm > 1 ? `${m.warm} ` : ''}warm compaction${m.warm > 1 ? 's' : ''}`)
  if (m.other) out.push(`${m.other > 1 ? `${m.other} ` : ''}compaction${m.other > 1 ? 's' : ''}`)
  return out.join(', ')
}

export interface Pt {
  x: number
  y: number
}

/**
 * The step area of `values` as SVG path data, one closed shape per run of drawn slots (a break
 * ends a run). `scale` is px per unit; the shape stands on `base` and grows upward.
 */
export function stepAreaPath(values: number[], axis: Axis, base: number, scale: number): string {
  const parts: string[] = []
  let i = 0
  const n = values.length
  const f = (v: number) => Math.round(v * 100) / 100
  while (i < n) {
    if (!axis.shown[i]) {
      i++
      continue
    }
    let j = i
    while (j < n && axis.shown[j]) j++
    // Only worth a shape if something is above zero in the run.
    let any = false
    for (let k = i; k < j; k++) if (values[k] > 0) any = true
    if (any) {
      let d = `M${f(axis.x[i])},${f(base)}`
      for (let k = i; k < j; k++) {
        const y = f(base - values[k] * scale)
        d += `L${f(axis.x[k])},${y}L${f(axis.x[k] + axis.slotW)},${y}`
      }
      d += `L${f(axis.x[j - 1] + axis.slotW)},${f(base)}Z`
      parts.push(d)
    }
    i = j
  }
  return parts.join('')
}

// ---- clicking a slot ---------------------------------------------------------------------

export interface SlotRange {
  from: number
  /** Inclusive. */
  to: number
}

/** The slots between two clicks (in either order), clamped to the plot. */
export function slotRange(a: number, b: number, slots: number): SlotRange {
  const lo = Math.max(0, Math.min(a, b))
  const hi = Math.min(slots - 1, Math.max(a, b))
  return { from: lo, to: hi }
}

export interface LaneHit {
  lane: OverviewLane
  /** Spend within the range. */
  usdIn: number
  /** The session's last activity, from the lane. */
  last?: string
}

/** The lanes with something in the slot range (spend or context), the priciest in the range first. */
export function lanesIn(lanes: OverviewLane[], r: SlotRange): LaneHit[] {
  const out: LaneHit[] = []
  for (const lane of lanes) {
    let usdIn = 0
    let live = false
    for (let i = r.from; i <= r.to; i++) {
      usdIn += lane.usdSlots[i] ?? 0
      if ((lane.usdSlots[i] ?? 0) > 0 || (lane.context[i] ?? 0) > 0) live = true
    }
    if (live) out.push({ lane, usdIn, last: lane.lastActivityAt })
  }
  return out.sort((a, b) => b.usdIn - a.usdIn || (a.lane.id < b.lane.id ? -1 : 1))
}

/** Time of the start of slot i. */
export const slotStart = (fromMs: number, slotMs: number, i: number): number => fromMs + i * slotMs

/** Opened groups live in the URL as a comma-separated list of escaped keys; the empty key is `-`. */
export function parseOpen(v: string | null): string[] {
  if (!v) return []
  return v.split(',').map((k) => (k === '-' ? '' : decodeURIComponent(k)))
}

export function formatOpen(keys: string[]): string {
  return keys.map((k) => (k === '' ? '-' : k === '-' ? '%2D' : encodeURIComponent(k))).join(',')
}

export function toggleOpen(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

/** "Tue 4 Nov 14:00-15:00" for slot i; a day slot is just the date. */
export function slotLabel(fromMs: number, slotMs: number, first: number, last = first): string {
  const a = new Date(fromMs + first * slotMs)
  const b = new Date(fromMs + (last + 1) * slotMs)
  const day = `${DAYS[a.getDay()]} ${a.getDate()} ${MONTHS[a.getMonth()]}`
  if (slotMs >= DAY && last === first) return day
  const sameDay = a.toDateString() === new Date(b.getTime() - 1).toDateString()
  const end = sameDay
    ? hm(b)
    : `${DAYS[new Date(b.getTime() - 1).getDay()]} ${new Date(b.getTime() - 1).getDate()} ${hm(b)}`
  return `${day} ${hm(a)}–${end}`
}
