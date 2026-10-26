// The spend graph's time view (timeline.ts has the numbers): wall-clock time across, a row per lane.
//
//   a row      the context of every call of its agent as an area above a baseline, on one token
//              scale for every row (a row is as tall as its largest context needs), and below the
//              baseline what it spent per slot of time, on one dollar scale for every row
//   held       a dotted line where an agent kept its context over a pause (its cache going cold), up
//              to the call that went on with it: strong while its turn or piece of work still ran
//              (waiting on a tool or an agent), faint between them (waiting for a message), with a
//              light tint under it (the context carried); the area always stops at the end of a turn
//              or a piece of work
//   marks      a diamond is a cache miss, a vertical mark a compaction (red on a cold cache)
//   main rows  each turn a thick stretch of the baseline; a dot for every prompt a person typed (hollow
//              if typed while a turn ran); a bracket with the total over each decision, its start reaching
//              down to the dot
//   agents     one light frame over an agent's work (its start down to the baseline, its top, a stem
//              at its end), each piece of work joined to the row that sent it (launch) and to the turn each of its reports came in (dashed); an addressable
//              agent keeps a row of its own, the others share rows when they do not overlap
//   breaks     time in which nothing ran is squeezed into a narrow band, with its length on the axis
//   overhead   under a session's rows, a hatched band over each reported window for what the harness
//              reported and no message explains: labelled with its dollars, on no scale, as it belongs
//              to the whole window and not to any slot, turn or agent in it
import { type KeyboardEvent, type PointerEvent, useId, useMemo, useRef, useState } from 'react'
import { callLine, idleText } from '../../lib/compaction'
import { formatDuration, formatMoney, formatTokens } from '../../lib/format'
import { niceTicks } from '../context/chart'
import { DECISION_TINT_OPACITY, TURN_TINT_OPACITY } from './marks'
import { CLASS_SERIES, KIND_SERIES, type KindKey, missText, type Split, type Unit } from './model'
import type { Pin, UnitRef } from './SpendGraph'
import {
  buildTimeline,
  clockTicks,
  HOLD_MS,
  type Lane,
  type Point,
  packLanes,
  type Row,
  slotLength,
  slotText,
  splitHeld,
  type TurnSpan,
  timeAxis,
  turnPlace,
} from './timeline'
import type { Overhead, Tree } from './tree'
import { useWidth } from './useWidth'

/** Room left of the plot for the context scale. */
const LABEL_W = 34
const MR = 12
const AXIS_H = 24
const BRACKET_H = 20
const TURNS_H = 13
/** The largest context of the tree is this tall. */
const CTX_FULL = 84
const CTX_MIN = 12
/** The most expensive slot of the tree is this tall. */
const SPEND_FULL = 40
const SPEND_MIN = 5
const ROW_GAP = 10
const BRANCH_GAP = 20
/** A spend bar is at least this wide. */
const SLOT_PX = 4
/** The strip of overhead bands under a session's rows, and the gap above it. */
const OVER_H = 14
const OVER_GAP = 6

const COLOR: Record<KindKey | 'main', string> = {
  ...(Object.fromEntries(KIND_SERIES.map((s) => [s.key, s.color])) as Record<KindKey, string>),
}
const ORDER = { kind: KIND_SERIES, class: CLASS_SERIES }

/** How strongly the context an agent carries over a pause is tinted, under its dotted line. */
const HELD_TINT = 0.08

const f1 = (n: number) => n.toFixed(1)
const ms = (s: string | undefined) => (s ? Date.parse(s) : Number.NaN)
const markColor = (call: { cache: string } | undefined) =>
  call?.cache === 'cold' ? 'var(--bad)' : call ? 'var(--warn)' : 'var(--faint)'

const clock = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const day = (t: number) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' })

/** The last point at or before `t`. */
function pointAt(points: readonly Point[], t: number): Point | undefined {
  let lo = 0
  let hi = points.length - 1
  let best: Point | undefined
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].t <= t) {
      best = points[mid]
      lo = mid + 1
    } else hi = mid - 1
  }
  return best
}

/**
 * Consecutive points with no pause longer than HOLD_MS between them, and none of the times in
 * `starts` (where a turn or a piece of work starts) either. A run that follows a start begins at it:
 * a call is written when its answer is, so the first one was sent with that context from the start
 * on (unless it came more than HOLD_MS later, as when the prompt failed and was sent again).
 */
function runsOf(points: readonly Point[], starts: readonly number[] = []): Point[][] {
  const out: Point[][] = []
  for (const p of points) {
    const run = out[out.length - 1]
    const prev = run?.[run.length - 1]
    const start = starts.findLast((c) => c <= p.t && (!prev || c > prev.t))
    if (prev && p.t - prev.t <= HOLD_MS && start === undefined) run.push(p)
    else
      out.push(start !== undefined && start < p.t && p.t - start <= HOLD_MS ? [{ t: start, tokens: p.tokens }, p] : [p])
  }
  return out
}

interface Layout {
  row: Row
  top: number
  /** The context's baseline: the area grows up from it, the spend down. */
  base: number
  ctxH: number
  spendH: number
  bottom: number
}

export interface TimePlotProps {
  tree: Tree
  split: Split
  pinned: Pin | null
  cursor: Pin | undefined
  selectedUnit: UnitRef | null
  hoverUnit: UnitRef | null
  onCursor: (p: Pin | null) => void
  onHoverUnit: (u: UnitRef | null) => void
  onPin: (p: Pin | null) => void
  onSelectUnit: (u: UnitRef) => void
  onKey: (e: KeyboardEvent<HTMLDivElement>) => void
}

export function TimePlot({
  tree,
  split,
  pinned,
  cursor,
  selectedUnit,
  hoverUnit,
  onCursor,
  onHoverUnit,
  onPin,
  onSelectUnit,
  onKey,
}: TimePlotProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const width = useWidth(wrap)
  const [px, setPx] = useState<{ x: number; row: number } | null>(null)
  const [band, setBand] = useState<{ branch: number; k: number } | null>(null)
  const hatch = `hatch${useId().replace(/[^a-zA-Z0-9-]/g, '')}`
  const tl = useMemo(() => buildTimeline(tree), [tree])
  const X0 = LABEL_W
  const X1 = Math.max(X0 + 80, width - MR)
  const axis = useMemo(() => timeAxis(tl.spans, X0, X1), [tl, X1])
  const rows = useMemo(() => packLanes(tl.lanes, axis.x), [tl, axis])
  const slot = slotLength(axis, SLOT_PX)

  // ---- the spend per slot of every row, on one dollar scale
  const slots = useMemo(
    () =>
      rows.map((r) => {
        const m = new Map<number, Record<string, number>>()
        for (const l of r.lanes)
          for (const c of l.calls) {
            const k = Math.floor(c.t / slot)
            const s = m.get(k) ?? {}
            if (split === 'class') for (const [key, v] of Object.entries(c.byClass)) s[key] = (s[key] ?? 0) + v
            else {
              s[c.kind] = (s[c.kind] ?? 0) + c.usd - c.reread
              s.reread = (s.reread ?? 0) + c.reread
            }
            s.total = (s.total ?? 0) + c.usd
            m.set(k, s)
          }
        return m
      }),
    [rows, slot, split],
  )
  const maxSlot = Math.max(1e-9, ...slots.flatMap((m) => [...m.values()].map((s) => s.total)))
  const kUsd = SPEND_FULL / maxSlot
  const cTicks = niceTicks(tl.peak || 1, 4)
  const ctxTop = cTicks[cTicks.length - 1]
  const kCtx = CTX_FULL / ctxTop

  // ---- vertical layout
  const layout: Layout[] = []
  const strips: { branch: number; top: number; bottom: number }[] = []
  let y = AXIS_H
  rows.forEach((row, i) => {
    if (i > 0) y += row.main ? BRANCH_GAP : ROW_GAP
    const top = y
    const peak = Math.max(...row.lanes.map((l) => l.peak))
    const ctxH = Math.max(CTX_MIN, Math.ceil(peak * kCtx) + 3) + (row.main ? BRACKET_H : 0)
    const maxS = Math.max(0, ...[...slots[i].values()].map((s) => s.total))
    const spendH = Math.max(SPEND_MIN, Math.ceil(maxS * kUsd) + 2) + (row.main ? TURNS_H : 0)
    layout.push({ row, top, base: top + ctxH, ctxH, spendH, bottom: top + ctxH + spendH })
    y = top + ctxH + spendH
    // the session's overhead, under its last row
    if (rows[i + 1]?.branch !== row.branch && tree.branches[row.branch]?.overhead.length) {
      strips.push({ branch: row.branch, top: y + OVER_GAP, bottom: y + OVER_GAP + OVER_H })
      y += OVER_GAP + OVER_H
    }
  })
  const height = y + 6
  const yCtx = (g: Layout, v: number) => g.base - v * kCtx

  // ---- who is where
  const mainRow = (branch: number) => layout.find((g) => g.row.main && g.row.branch === branch)
  const rowByName = new Map<string, Layout>()
  for (const g of layout) for (const l of g.row.lanes) if (l.agent?.name) rowByName.set(l.agent.name, g)
  const unitRef = (l: Lane, u: Unit): UnitRef => ({ branch: l.branch, id: u.id })
  const isOn = (l: Lane, u: Unit) => [hoverUnit, selectedUnit].some((r) => r && r.branch === l.branch && r.id === u.id)
  // a turn of no width can still be hovered
  const slackMs = 3 / axis.scale
  /** The turn running at `t`; none between two turns. */
  const turnOn = (l: Lane | undefined, t: number): Pin | null => {
    const p = l ? turnPlace(l.turns, t, slackMs) : undefined
    return l && p && 'turn' in p ? { branch: l.branch, col: p.turn.col.index } : null
  }
  /** When each of a unit's reports came in: the start of the turn it began. */
  const arrivals = (u: Unit) => {
    const b = tree.branches.find((x) => x.model.units.includes(u))
    return u.reports.map((r) => ms(b?.model.cols[r]?.turn.startedAt)).filter(Number.isFinite)
  }
  const overX = (o: Overhead): [number, number] => {
    const a = axis.x(Math.max(o.t0, tl.t0))
    return [a, Math.max(a + 3, axis.x(Math.min(o.t1, tl.t1)))]
  }
  const uX = (u: Unit): [number, number] => {
    const a = axis.x(u.startMs)
    return [a, Math.max(a + 3, axis.x(Number.isFinite(u.endMs) ? u.endMs : u.startMs))]
  }

  // ---- the pointer
  const hit = (clientX: number, clientY: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const x = clientX - r.left
    const yy = clientY - r.top
    if (x < X0 - 4 || x > X1 + 4) return null
    if (strips.some((s) => yy >= s.top - OVER_GAP / 2 && yy <= s.bottom + 2)) return null
    const k = layout.findIndex((g, i) => yy < g.bottom + (layout[i + 1] ? (layout[i + 1].top - g.bottom) / 2 : 99))
    if (k < 0) return null
    return { x, row: k, t: axis.t(x) }
  }
  const read = (h: { x: number; row: number; t: number }) => {
    const g = layout[h.row]
    if (g.row.main) {
      return { pin: turnOn(g.row.lanes[0], h.t), unit: null }
    }
    // the piece of work under the pointer, or the nearest within a few pixels
    let best: { lane: Lane; unit: Unit; d: number } | undefined
    for (const l of g.row.lanes)
      for (const u of l.units) {
        const [a, b] = uX(u)
        const d = h.x < a ? a - h.x : h.x > b ? h.x - b : 0
        if (d <= 6 && (!best || d < best.d)) best = { lane: l, unit: u, d }
      }
    if (!best) return { pin: null, unit: null }
    return { pin: turnOn(mainRow(best.lane.branch)?.row.lanes[0], h.t), unit: unitRef(best.lane, best.unit) }
  }
  /** The overhead band under the pointer. */
  const bandAt = (clientX: number, clientY: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const x = clientX - r.left
    const yy = clientY - r.top
    const s = strips.find((s) => yy >= s.top - 2 && yy <= s.bottom + 2)
    const k = s
      ? tree.branches[s.branch].overhead.findIndex((o) => {
          const [a, b] = overX(o)
          return x >= a - 3 && x <= b + 3
        })
      : -1
    return s && k >= 0 ? { branch: s.branch, k } : null
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    setBand(bandAt(e.clientX, e.clientY, e.currentTarget))
    const h = hit(e.clientX, e.clientY, e.currentTarget)
    setPx(h ? { x: h.x, row: h.row } : null)
    const r = h ? read(h) : { pin: null, unit: null }
    onCursor(r.pin)
    onHoverUnit(r.unit)
  }

  // the crosshair: the pointer, or the turn the keyboard is on
  const crossX =
    px?.x ??
    (cursor
      ? (() => {
          const l = mainRow(cursor.branch)?.row.lanes[0]
          const s = l?.turns.find((x) => x.col.index === cursor.col)
          return s ? axis.x(s.t0) : undefined
        })()
      : undefined)
  const crossT = crossX !== undefined ? axis.t(crossX) : undefined

  // ---- drawing helpers
  const area = (g: Layout, run: Point[]) => {
    const pts = run.map((p, i) => {
      const x = f1(axis.x(p.t))
      const prev = run[i - 1]
      return `${prev ? `L${x} ${f1(yCtx(g, prev.tokens))}` : ''}L${x} ${f1(yCtx(g, p.tokens))}`
    })
    const xa = axis.x(run[0].t)
    const xb = Math.max(axis.x(run[run.length - 1].t), xa + 1.5)
    const yl = f1(yCtx(g, run[run.length - 1].tokens))
    return `M${f1(xa)} ${g.base}${pts.join('')}L${f1(xb)} ${yl}L${f1(xb)} ${g.base}Z`
  }
  const line = (g: Layout, run: Point[]) =>
    run
      .map((p, i) => {
        const x = f1(axis.x(p.t))
        const prev = run[i - 1]
        return prev
          ? `L${x} ${f1(yCtx(g, prev.tokens))}L${x} ${f1(yCtx(g, p.tokens))}`
          : `M${x} ${f1(yCtx(g, p.tokens))}`
      })
      .join('')

  const drawLane = (g: Layout, l: Lane) => {
    const color = COLOR[l.kind]
    const own = l.series.find((s) => s.own)
    // an agent waits between its turns or pieces of work (for a message), however short the wait
    const starts = l.main ? l.turns.map((t) => t.t0) : l.units.map((u) => u.startMs)
    const runs = own
      ? runsOf(
          own.points,
          starts.toSorted((a, b) => a - b),
        )
      : []
    const top = g.row.main ? g.top + BRACKET_H : g.top
    // what the agent was busy with: a main agent's turns, a one-shot agent's piece of work; an addressable agent's whole life, so that the
    // context it holds between its pieces of work joins them as strongly as a main agent's turns do
    const busy: { t0: number; t1: number }[] = l.main
      ? l.turns
      : l.kind === 'addressable' && Number.isFinite(l.t0)
        ? [{ t0: l.t0, t1: l.t1 }]
        : l.units
            .filter((u) => Number.isFinite(u.startMs))
            .map((u) => ({ t0: u.startMs, t1: Math.max(u.startMs, u.endMs) }))
    return (
      <g key={l.key}>
        {/* the agent's work: one light frame over all of it, as over a decision (its start down to the
            baseline, its top, a stem at its end), with its top heavier over the piece hovered or selected */}
        {l.units.length > 0 &&
          (() => {
            const xs = l.units.map(uX)
            const a = Math.min(...xs.map(([x]) => x))
            const b = Math.max(...xs.map(([, x]) => x))
            const dash = l.agent?.kind === 'workflow' ? '4 2' : undefined
            const label = l.title
            const cost = formatMoney(l.usd)
            const room = b - a - (l.kind === 'fork' ? 9 : 4) - 4
            const text =
              room >= (label.length + cost.length + 3) * 5.6
                ? `${label}${label ? ' · ' : ''}${cost}`
                : room >= label.length * 5.6
                  ? label
                  : ''
            return (
              <g>
                <path
                  d={`M${f1(a)} ${g.base}V${top}H${f1(b)}V${top + 4}`}
                  fill="none"
                  stroke={color}
                  strokeOpacity={0.55}
                  strokeWidth={1}
                  strokeDasharray={dash}
                />
                {l.units.map(
                  (u, k) =>
                    isOn(l, u) && (
                      <line
                        key={u.id}
                        x1={xs[k][0]}
                        x2={xs[k][1]}
                        y1={top}
                        y2={top}
                        stroke={color}
                        strokeWidth={3}
                        strokeDasharray={dash}
                      />
                    ),
                )}
                {l.kind === 'fork' && <path d={`M${f1(a)} ${top}h7l-7 7z`} fill={color} />}
                {text && (
                  <text x={a + (l.kind === 'fork' ? 9 : 4)} y={top + 10} fontSize={9.5} fill="var(--muted)">
                    {text}
                  </text>
                )}
              </g>
            )
          })()}
        {/* the context: an area while the agent works, dotted while it holds it over a pause */}
        {runs.map((run, i) => (
          <g key={run[0].t}>
            <path d={area(g, run)} fill={color} fillOpacity={0.22} />
            <path d={line(g, run)} fill="none" stroke={color} strokeWidth={1.25} strokeLinejoin="round" />
            {runs[i + 1] && (
              <g>
                <title>{`${formatTokens(run[run.length - 1].tokens)} of context held for ${formatDuration(runs[i + 1][0].t - run[run.length - 1].t)}`}</title>
                {/* the context carried over the pause, lighter than where it was in use */}
                <rect
                  x={axis.x(run[run.length - 1].t)}
                  y={yCtx(g, run[run.length - 1].tokens)}
                  width={Math.max(0, axis.x(runs[i + 1][0].t) - axis.x(run[run.length - 1].t))}
                  height={g.base - yCtx(g, run[run.length - 1].tokens)}
                  fill={color}
                  fillOpacity={HELD_TINT}
                />
                {splitHeld(run[run.length - 1].t, runs[i + 1][0].t, busy).map((p) => (
                  <line
                    key={p.t0}
                    x1={axis.x(p.t0)}
                    x2={axis.x(p.t1)}
                    y1={yCtx(g, run[run.length - 1].tokens)}
                    y2={yCtx(g, run[run.length - 1].tokens)}
                    stroke={color}
                    strokeOpacity={p.busy ? 1 : 0.4}
                    strokeWidth={p.busy ? 1.5 : 1.25}
                    strokeDasharray={p.busy ? '1.5 2.5' : '1.5 4'}
                    strokeLinecap="round"
                  />
                ))}
              </g>
            )}
          </g>
        ))}
        {/* its own sub-agents' contexts */}
        {l.series
          .filter((s) => !s.own)
          .flatMap((s) =>
            runsOf(s.points).map((run) => (
              <path
                key={`${s.agentId}/${run[0].t}`}
                d={line(g, run)}
                fill="none"
                stroke={color}
                strokeWidth={1}
                strokeOpacity={0.6}
              />
            )),
          )}
        {l.compactions.map((c) => {
          const x = axis.x(c.t)
          const pre = c.compaction.preTokens
          const cold = c.compaction.call?.cache === 'cold'
          return (
            <line
              key={`${c.agent?.id ?? ''}${c.compaction.at}`}
              x1={x}
              x2={x}
              y1={pre ? Math.max(top - 2, yCtx(g, pre) - 4) : top}
              y2={g.base}
              stroke={markColor(c.compaction.call)}
              strokeWidth={cold ? 2 : 1.5}
              strokeDasharray={cold ? undefined : '3 2'}
            >
              <title>
                {`compaction${c.agent ? ` of ${c.agent.name ?? c.agent.kind}` : ''}${pre ? ` at ${formatTokens(pre)}` : ''}${c.compaction.postTokens ? ` → ${formatTokens(c.compaction.postTokens)}` : ''}${c.compaction.call ? `: ${callLine(c.compaction.call, !!c.compaction.messageId)}` : ''}`}
              </title>
            </line>
          )
        })}
        {l.misses.map((m) => {
          const x = axis.x(m.t)
          const yy = yCtx(g, m.tokens)
          return (
            <rect
              key={`${m.t}/${m.reread.agentId ?? ''}`}
              x={x - 4}
              y={yy - 4}
              width={8}
              height={8}
              transform={`rotate(45 ${f1(x)} ${f1(yy)})`}
              fill="var(--series-5)"
              stroke="var(--surface)"
              strokeWidth={1.5}
            >
              <title>{`cache miss: ${formatTokens(m.reread.tokens)} billed again ${missText(m.reread)}, ${formatMoney(m.reread.usd)}`}</title>
            </rect>
          )
        })}
      </g>
    )
  }

  const drawRow = (g: Layout, i: number) => {
    const order = ORDER[split]
    const main = g.row.main ? g.row.lanes[0] : undefined
    const b = tree.branches[g.row.branch]
    const ticks = cTicks.filter((t) => t > 0 && t * kCtx <= g.ctxH - (main ? BRACKET_H : 0) - 2)
    const turnsY = g.bottom - 3
    let lastTurnX = Number.NEGATIVE_INFINITY
    return (
      <g key={g.row.lanes[0].key}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={X0} x2={X1} y1={yCtx(g, t)} y2={yCtx(g, t)} stroke="var(--line)" strokeWidth={1} />
            <text x={X0 - 4} y={yCtx(g, t)} textAnchor="end" dominantBaseline="middle" fontSize={9} fill="var(--faint)">
              {formatTokens(t)}
            </text>
          </g>
        ))}
        {/* the decisions over a main row */}
        {main &&
          b.model.decisions.map((dec) => {
            const s0 =
              main.turns.find((s) => s.col.index === dec.start) ?? main.turns.find((s) => s.col.index >= dec.start)
            const s1 = [...main.turns].reverse().find((s) => s.col.index <= dec.end)
            if (!s0 || !s1 || dec.usd <= 0 || s1.col.index < s0.col.index) return null
            const xa = axis.x(s0.t0) + 1
            const xb = Math.max(xa + 3, axis.x(s1.t1) - 1)
            const yy = g.top + 12
            const held = pinned?.branch === g.row.branch && b.model.cols[pinned.col]?.decision === dec.index
            const on = held || (cursor?.branch === g.row.branch && b.model.cols[cursor.col]?.decision === dec.index)
            const text = formatMoney(dec.usd)
            return (
              <g key={dec.index} pointerEvents="none">
                <path
                  d={`M${f1(axis.x(s0.t0))} ${g.base}V${yy}H${f1(xb)}V${yy + 3}`}
                  fill="none"
                  stroke={held ? 'var(--accent)' : on ? 'var(--text)' : 'var(--faint)'}
                  strokeWidth={held ? 3 : 1}
                />
                {(xb - xa >= text.length * 6 + 4 || on) && (
                  <text
                    x={(xa + xb) / 2}
                    y={yy - 3}
                    textAnchor="middle"
                    fontSize={10}
                    fontWeight={on ? 600 : 400}
                    fill={on ? 'var(--text)' : 'var(--muted)'}
                    stroke="var(--surface)"
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {text}
                  </text>
                )}
              </g>
            )
          })}
        {/* an addressable agent's life: from its launch to its last piece of work */}
        {g.row.lanes.map(
          (l) =>
            l.kind === 'addressable' &&
            Number.isFinite(l.t0) && (
              <line
                key={`life${l.key}`}
                x1={axis.x(l.t0)}
                x2={axis.x(l.t1)}
                y1={g.base}
                y2={g.base}
                stroke={COLOR.addressable}
                strokeOpacity={0.5}
                strokeWidth={1}
                strokeDasharray="3 3"
              />
            ),
        )}
        {g.row.lanes.map((l) => drawLane(g, l))}
        {/* the spend per slot, down from the baseline */}
        {[...slots[i].entries()].map(([k, s]) => {
          let off = 0
          return (
            <g key={k}>
              {order.map((p) => {
                const v = s[p.key] ?? 0
                if (v <= 0) return null
                const h = v * kUsd
                const r = (
                  <rect
                    key={p.key}
                    x={axis.x(k * slot) + 0.5}
                    y={g.base + 1 + off}
                    width={Math.max(1, axis.x((k + 1) * slot) - axis.x(k * slot) - 1)}
                    height={Math.max(h, 0.6)}
                    fill={p.color}
                  />
                )
                off += h
                return r
              })}
            </g>
          )
        })}
        <line
          x1={X0}
          x2={X1}
          y1={g.base + 0.5}
          y2={g.base + 0.5}
          stroke={main ? 'var(--faint)' : 'var(--line)'}
          strokeWidth={1}
        />
        {/* a main row's turns, and their numbers */}
        {main?.turns.map((s) => {
          const x = axis.x(s.t0)
          const label = x - lastTurnX >= String(s.col.index).length * 5.5 + 6
          if (label) lastTurnX = x
          const xe = Math.max(x + 1.5, axis.x(s.t1) - 0.75)
          return (
            <g key={s.col.index} pointerEvents="none">
              <line x1={x + 0.75} x2={xe} y1={g.base + 0.5} y2={g.base + 0.5} stroke="var(--text)" strokeWidth={3} />
              <line x1={x} x2={x} y1={g.base - 4} y2={g.base + 5} stroke="var(--text)" strokeWidth={1} />
              {label && (
                <text x={x} y={turnsY} textAnchor="middle" fontSize={9} fill="var(--faint)">
                  {s.col.index}
                </text>
              )}
            </g>
          )
        })}
        {/* a person's messages: a dot on the baseline, hollow for one typed while a turn ran */}
        {main?.turns.flatMap((s) =>
          [
            ...(s.col.human ? [{ t: s.t0, queued: false }] : []),
            // typed while the turn ran: it starts no turn, but it steered this one
            ...(s.col.turn.queued ?? [])
              .filter((q) => q.origin === 'human' || q.origin === 'command')
              .map((q) => ({ t: ms(q.at), queued: true })),
          ]
            .filter((m) => Number.isFinite(m.t))
            .map((m) => {
              const x = axis.x(m.t)
              return (
                <g key={`m${m.t}`} pointerEvents="none">
                  <circle
                    cx={x}
                    cy={g.base}
                    r={2.8}
                    fill={m.queued ? 'var(--surface)' : 'var(--text)'}
                    stroke={m.queued ? 'var(--text)' : 'var(--surface)'}
                    strokeWidth={m.queued ? 1.25 : 1}
                  />
                </g>
              )
            }),
        )}
      </g>
    )
  }

  // ---- launches, messages and reports between the rows
  // only for the work in focus: hovered or selected, or launched in the turn under the cursor or pinned
  const focusTurns = [cursor, pinned].filter((p): p is Pin => !!p)
  const inFocus = (l: Lane, u: Unit) =>
    isOn(l, u) || focusTurns.some((p) => p.branch === l.branch && (u.launch === p.col || u.reports.includes(p.col)))
  const connectors = layout.flatMap((g) =>
    g.row.main
      ? []
      : g.row.lanes.flatMap((l) =>
          l.units
            .filter((u) => inFocus(l, u))
            .map((u) => {
              const color = COLOR[l.kind]
              const on = isOn(l, u)
              // work its own background tasks woke was sent by nobody: no line comes down to it
              const from = u.woken ? undefined : (u.from && rowByName.get(u.from)) || mainRow(l.branch)
              const to = mainRow(l.branch)
              const [a] = uX(u)
              const fy = from ? from.base : g.top
              return (
                <g key={`c${l.key}/${u.id}`} pointerEvents="none" opacity={on ? 1 : 0.7}>
                  {from && from !== g && (
                    <>
                      <line
                        x1={a}
                        x2={a}
                        y1={fy + (from.top < g.top ? 2 : -2)}
                        y2={from.top < g.top ? g.top - 3 : g.bottom + 3}
                        stroke={color}
                        strokeWidth={on ? 1.5 : 1}
                      />
                      {from.top < g.top && (
                        <path
                          d={`M${f1(a - 3)} ${g.top - 5}L${f1(a)} ${g.top}L${f1(a + 3)} ${g.top - 5}Z`}
                          fill={color}
                        />
                      )}
                    </>
                  )}
                  {to &&
                    arrivals(u).map((t) => {
                      const xb = axis.x(t)
                      return (
                        <g key={t}>
                          <line
                            x1={xb}
                            x2={xb}
                            y1={g.top}
                            y2={to.base + 5}
                            stroke={color}
                            strokeWidth={on ? 1.5 : 1}
                            strokeDasharray="2 2"
                          />
                          <path
                            d={`M${f1(xb - 3)} ${to.base + 6}L${f1(xb)} ${to.base + 1.5}L${f1(xb + 3)} ${to.base + 6}Z`}
                            fill={color}
                          />
                        </g>
                      )
                    })}
                </g>
              )
            }),
        ),
  )
  // a forked or continued session starts off its parent's row
  const forks = layout.flatMap((g) => {
    const b = tree.branches[g.row.branch]
    const parent = b.parent !== undefined ? mainRow(b.parent) : undefined
    const l = g.row.lanes[0]
    if (!g.row.main || !parent || !Number.isFinite(l.t0)) return []
    const x = axis.x(l.t0)
    return [
      <path
        key={`f${l.key}`}
        d={`M${f1(x)} ${parent.base}V${g.base}`}
        stroke="var(--text)"
        strokeWidth={1.25}
        fill="none"
        opacity={0.6}
      >
        <title>{b.kind === 'continuation' ? 'continued in a new session' : 'forked into a new session'}</title>
      </path>,
    ]
  })

  // ---- pinned turn, its decision, the cursor
  const pinMarks = (() => {
    if (!pinned) return null
    const g = mainRow(pinned.branch)
    const l = g?.row.lanes[0]
    const s = l?.turns.find((x) => x.col.index === pinned.col)
    if (!g || !l || !s) return null
    const b = tree.branches[pinned.branch]
    const dec = b.model.decisions[b.model.cols[pinned.col].decision]
    const d0 = l.turns.find((x) => x.col.index >= dec.start)
    const d1 = [...l.turns].reverse().find((x) => x.col.index <= dec.end)
    const rowsOf = layout.filter((x) => x.row.branch === pinned.branch)
    const yTop = rowsOf[0].top
    const yBot = rowsOf[rowsOf.length - 1].bottom
    const xa = axis.x(s.t0)
    const xb = Math.max(xa + 2, axis.x(s.t1))
    return (
      <g pointerEvents="none">
        {d0 && d1 && (
          <rect
            x={axis.x(d0.t0)}
            y={yTop}
            width={Math.max(2, axis.x(d1.t1) - axis.x(d0.t0))}
            height={yBot - yTop}
            fill="var(--accent)"
            opacity={DECISION_TINT_OPACITY}
          />
        )}
        <rect
          x={xa}
          y={g.top}
          width={xb - xa}
          height={g.bottom - g.top}
          fill="var(--accent)"
          opacity={TURN_TINT_OPACITY}
        />
        <path d={`M${f1(xa - 4)} ${g.top - 1}h8l-4 6z`} fill="var(--accent)" />
      </g>
    )
  })()

  // the labels along the top, left to right, each where it does not run into the one before: clock
  // times (with the date where it changes), and how long each break was
  const multiDay = day(tl.t0) !== day(tl.t1)
  const ticks = clockTicks(axis, 70)
  const axisLabels = [
    ...ticks.map((t, i) => ({
      key: `t${t}`,
      x: axis.x(t),
      text: multiDay && (i === 0 || day(t) !== day(ticks[i - 1])) ? `${day(t)} ${clock(t)}` : clock(t),
      gap: false,
    })),
    ...axis.breaks.map((b) => ({ key: `b${b.t0}`, x: (b.x0 + b.x1) / 2, text: gapText(b.t1 - b.t0), gap: true })),
  ]
    .sort((a, b) => a.x - b.x)
    .filter(
      ((end) => (l: { x: number; text: string }) => {
        const w = l.text.length * 5.8
        if (l.x - w / 2 < end.v + 8) return false
        end.v = l.x + w / 2
        return true
      })({ v: Number.NEGATIVE_INFINITY }),
    )

  // ---- what is under the pointer, in one line
  const under = (() => {
    if (crossT === undefined) return null
    const g = px ? layout[px.row] : cursor ? mainRow(cursor.branch) : undefined
    if (!g) return null
    const k = Math.floor(crossT / slot)
    const s = slots[layout.indexOf(g)].get(k)
    const ctx = g.row.lanes
      .flatMap((l) => {
        const own = l.series.find((x) => x.own)
        if (!own || crossT < l.t0 - HOLD_MS || crossT > l.t1 + HOLD_MS) return []
        const p = pointAt(own.points, crossT)
        // an agent between two of its pieces of work waits for a message
        const k = l.main ? -1 : l.units.findIndex((u) => u.startMs > crossT)
        const wait = k > 0 && l.units[k - 1].endMs < crossT ? crossT - l.units[k - 1].endMs : undefined
        return p ? [{ l, p, wait }] : []
      })
      .pop()
    const place = g.row.main ? turnPlace(g.row.lanes[0].turns, crossT, slackMs) : undefined
    const between = place && 'after' in place ? place : undefined
    return { g, s, ctx, between }
  })()
  const betweenText = (p: { after: TurnSpan; next?: TurnSpan }) =>
    p.next
      ? `between turns ${p.after.col.index} and ${p.next.col.index}: main agent idle ${idleText(p.next.t0 - p.after.t1)}${p.next.col.human ? ', waiting for you' : ''}`
      : `after turn ${p.after.col.index}`

  return (
    <div>
      <div className="flex min-h-5 items-baseline gap-x-3 overflow-hidden whitespace-nowrap text-sec text-muted">
        {band ? (
          <OverheadText o={tree.branches[band.branch].overhead[band.k]} />
        ) : under ? (
          <>
            <span className="font-mono text-text">{clock(crossT ?? 0)}</span>
            {under.between && <span>{betweenText(under.between)}</span>}
            {under.ctx && (
              <span>
                {under.ctx.l.main ? 'main agent' : under.ctx.l.title}:{' '}
                <span className="font-mono text-text">{formatTokens(under.ctx.p.tokens)}</span> context
                {under.ctx.wait !== undefined
                  ? `, held, waiting for a message ${idleText(under.ctx.wait)}`
                  : crossT !== undefined &&
                    crossT - under.ctx.p.t > HOLD_MS &&
                    `, held ${idleText(crossT - under.ctx.p.t)}`}
              </span>
            )}
            <span>
              this {slotText(slot)} on the row:{' '}
              <span className="font-mono text-text">{formatMoney(under.s?.total ?? 0)}</span>
            </span>
          </>
        ) : (
          <span className="text-faint">
            Context per call above each baseline, on one scale; spend per {slotText(slot)} below it, on one scale (the
            tallest bar is {formatMoney(maxSlot)}).
          </span>
        )}
      </div>
      <div
        ref={wrap}
        role="slider"
        tabIndex={0}
        aria-label="Context and spend of every agent over time"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, tree.branches[0]?.model.cols.length - 1)}
        aria-valuenow={cursor?.col ?? pinned?.col ?? 0}
        onPointerMove={onMove}
        onPointerLeave={(e) => {
          setPx(null)
          setBand(null)
          if (document.activeElement !== e.currentTarget) onCursor(null)
          onHoverUnit(null)
        }}
        onBlur={() => onCursor(null)}
        onClick={(e) => {
          const h = hit(e.clientX, e.clientY, e.currentTarget)
          if (!h) return
          const r = read(h)
          if (r.unit) onSelectUnit(r.unit)
          else if (r.pin) onPin(r.pin)
        }}
        onKeyDown={(e) => {
          setPx(null)
          onKey(e)
        }}
        className="relative mt-1 cursor-crosshair rounded-badge"
      >
        <svg width={width} height={height} role="img" aria-label="Spend over time" className="block">
          {/* breaks: idle time left out */}
          {axis.breaks.map((b) => (
            <g key={b.t0}>
              <rect
                x={b.x0 + 3}
                y={AXIS_H - 6}
                width={b.x1 - b.x0 - 6}
                height={height - AXIS_H}
                fill="var(--surface-2)"
                opacity={0.8}
              />
              <path
                d={`M${f1(b.x0 + 3)} ${AXIS_H - 6}l3 -4M${f1(b.x1 - 6)} ${AXIS_H - 6}l3 -4`}
                stroke="var(--faint)"
                strokeWidth={1}
              />
              <title>{`${formatDuration(b.t1 - b.t0)} in which nothing ran, left out`}</title>
            </g>
          ))}
          {ticks.map((t) => (
            <line
              key={t}
              x1={axis.x(t)}
              x2={axis.x(t)}
              y1={AXIS_H - 4}
              y2={height}
              stroke="var(--line)"
              strokeWidth={1}
              opacity={0.6}
            />
          ))}
          {axisLabels.map((l) => (
            <text
              key={l.key}
              x={l.x}
              y={11}
              textAnchor="middle"
              fontSize={l.gap ? 9.5 : 10}
              fill={l.gap ? 'var(--faint)' : 'var(--muted)'}
            >
              {l.text}
            </text>
          ))}
          <defs>
            <pattern id={hatch} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1={0} y1={0} x2={0} y2={5} stroke="var(--muted)" strokeWidth={1.25} strokeOpacity={0.55} />
            </pattern>
          </defs>
          {pinMarks}
          {layout.map(drawRow)}
          {strips.flatMap((s) =>
            tree.branches[s.branch].overhead.map((o, k) => {
              const [a, b] = overX(o)
              const on = band?.branch === s.branch && band.k === k
              const money = formatMoney(o.usd)
              const long = `${money} reported, not explained by messages`
              const room = b - a - 8
              const text = room >= long.length * 5.6 ? long : room >= money.length * 5.6 ? money : ''
              return (
                <g key={`o${s.branch}/${o.t0}`} pointerEvents="none">
                  <rect
                    x={a}
                    y={s.top}
                    width={b - a}
                    height={OVER_H}
                    rx={2}
                    fill={`url(#${hatch})`}
                    stroke="var(--muted)"
                    strokeOpacity={on ? 0.9 : 0.4}
                    strokeWidth={on ? 1.25 : 1}
                  />
                  {text && (
                    <text
                      x={a + 4}
                      y={s.top + OVER_H / 2 + 3.5}
                      fontSize={10}
                      fontWeight={on ? 600 : 400}
                      fill={on ? 'var(--text)' : 'var(--muted)'}
                      stroke="var(--surface)"
                      strokeWidth={3}
                      paintOrder="stroke"
                    >
                      {text}
                    </text>
                  )}
                </g>
              )
            }),
          )}
          {forks}
          {connectors}
          {crossX !== undefined && (
            <g pointerEvents="none">
              <line
                x1={crossX}
                x2={crossX}
                y1={AXIS_H - 4}
                y2={height}
                stroke="var(--text)"
                strokeWidth={1}
                opacity={0.35}
              />
            </g>
          )}
        </svg>
      </div>
    </div>
  )
}

/** What an overhead band stands for, in one line. */
function OverheadText({ o }: { o: Overhead }) {
  const when = (t: number) => `${day(t)} ${clock(t)}`
  return (
    <span className="truncate">
      Claude Code reported <span className="font-mono text-text">{formatMoney(o.reportedUSD)}</span> from {when(o.t0)}{' '}
      to {when(o.t1)}; its messages add up to <span className="font-mono text-text">{formatMoney(o.coveredUSD)}</span>,
      so <span className="font-mono text-text">{formatMoney(o.usd)}</span> went on calls it does not write down, in no
      one turn or agent
    </span>
  )
}

/** A break's length, short: "25m", "3h 30m", "2d 4h". */
function gapText(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`
}
