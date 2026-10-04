// The spend graph: a tree of sessions on one turn axis, and what each decision cost.
//
//   context   the context size along the path from the trunk to the branch in focus
//   a branch  a session's own turns as a line. A session forked or continued from another starts
//             where it left its parent, on a line of its own below it.
//   steps     above a line, one bar per turn: what that session's main agent spent in it
//   the line  a dot for every prompt a person typed (a ring: typed while a turn ran); a bracket over
//             everything up to the next one; a compaction is a mark after its turn, red when the
//             cache had gone cold, with the estimated cost of its call
//   agents    below a line, one bar per piece of work handed to an agent, under the turn that
//             launched it and as tall as it cost, with a tail to the turn its report arrived in
//
// Every bar is on one dollar scale, and nothing is accumulated.
import { type KeyboardEvent, type PointerEvent, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { callLine, idleText, tallyLine, warmLine } from '../../lib/compaction'
import { formatCount, formatDuration, formatMoney, formatPercent, formatTokens, plural } from '../../lib/format'
import { firstLine } from '../../lib/paths'
import { unwrapMachineText } from '../../lib/wrapper'
import { Card, ModelName, SegmentedControl } from '../../ui'
import { KindIcon } from '../agents/AgentRow'
import { agentLabel } from '../agents/model'
import { niceTicks } from '../context/chart'
import { compactionTally, type Part, type Split, stepParts, type Unit, unitParts } from './model'
import { type Branch, pathPoints, pathTo, type Tree } from './tree'

/** A turn of a branch. */
export interface Pin {
  branch: number
  col: number
}

/** A piece of agent work of a branch. */
export interface UnitRef {
  branch: number
  id: string
}

export interface SpendGraphProps {
  tree: Tree
  /** The branch the page was opened on: the context line follows it until something is pinned. */
  home: number
  /** The turn the inspector shows. */
  pinned: Pin | null
  onPin: (pin: Pin | null) => void
  selectedUnit: UnitRef | null
  onSelectUnit: (unit: UnitRef) => void
  initialSplit?: Split
  /** Dev and screenshots: start with the cursor on this turn of the home branch. */
  initialCursor?: number
}

const ML = 46
const MR = 10
const CTX_TOP = 20
const CTX_H = 92
const TICKS_H = 16
const TITLE_H = 18
const BRACKET_H = 22
const STEP_MIN_H = 30
/** The most expensive step or unit is this tall. */
const SCALE_PX = 96
const ROW_MIN = 8
const ROW_GAP = 9
const LABEL_H = 11
const BAND_GAP = 26
const KIND_COLOR: Record<string, string> = {
  subagent: 'var(--series-2)',
  teammate: 'var(--series-3)',
  workflow: 'var(--series-2)',
  fork: 'var(--series-4)',
  compact: 'var(--series-other)',
}

/** A compaction's mark: red when its call ran on a cold cache, amber when warm, grey when unknown. */
const markColor = (call: { cache: string } | undefined) =>
  call?.cache === 'cold' ? 'var(--bad)' : call ? 'var(--warn)' : 'var(--faint)'

function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(900)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setW(Math.floor(el.getBoundingClientRect().width) || 900)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width) || 900))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

const f1 = (n: number) => n.toFixed(1)

function Swatch({ color }: { color: string }) {
  return <span aria-hidden className="inline-block size-2 shrink-0 rounded-[2px]" style={{ background: color }} />
}

function Chips({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map(
        (p) =>
          p.usd >= 0.005 && (
            <span key={p.key} className="inline-flex items-center gap-1">
              <Swatch color={p.color} />
              <span className="text-muted">{p.label}</span>
              <span className="font-mono">{formatMoney(p.usd)}</span>
            </span>
          ),
      )}
    </>
  )
}

/** The fixed-height lines above the plot that say what is under the cursor. */
function Readout({
  tree,
  at,
  unit,
  split,
}: {
  tree: Tree
  at: Pin | undefined
  unit: { branch: Branch; unit: Unit } | undefined
  split: Split
}) {
  if (!at && !unit) {
    return (
      <div className="min-h-[4.5rem] text-sec text-faint">
        Hover, or press ← →, to read a turn; hover a bar under a line to read what an agent was given. Click pins it and
        opens it below.
      </div>
    )
  }
  const b = unit ? unit.branch : tree.branches[at?.branch ?? 0]
  const c = b.model.cols[unit ? unit.unit.launch : (at?.col ?? 0)]
  const dec = b.model.decisions[c.decision]
  const launchedUSD = c.launched.reduce((s, u) => s + u.bucket.usd, 0)
  const u = unit?.unit
  return (
    <div className="min-h-[4.5rem] space-y-0.5 text-sec" aria-live="polite">
      <div className="flex flex-wrap items-baseline gap-x-3">
        {tree.branches.length > 1 && <span className="max-w-64 truncate font-medium">{b.title}</span>}
        <span className="font-mono">turn {c.index}</span>
        <span title="what the main agent spent in this turn">
          step <span className="font-mono font-semibold">{formatMoney(c.usd)}</span>
        </span>
        {c.launched.length > 0 && (
          <span title="work handed to agents in this turn, at its full cost">
            launched {c.launched.length} · <span className="font-mono font-semibold">{formatMoney(launchedUSD)}</span>
          </span>
        )}
        {dec.end > dec.start && (
          <span className="text-muted" title="everything between the prompt you typed and your next one">
            turns {dec.start}–{dec.end} together: <span className="font-mono">{formatMoney(dec.usd)}</span>
          </span>
        )}
        {typeof c.turn.contextTokens === 'number' && (
          <span className="font-mono text-muted" title={`${formatCount(c.turn.contextTokens)} tokens of context`}>
            {formatTokens(c.turn.contextTokens)} context
          </span>
        )}
        {c.idleMs !== undefined && c.idleMs >= 60_000 && (
          <span className="text-muted">after {formatDuration(c.idleMs)} idle</span>
        )}
        {c.turn.abandoned && <span className="text-muted">rewound</span>}
        {!c.human && <span className="text-faint">{c.turn.origin}</span>}
      </div>
      {u ? (
        <>
          <div className="flex items-center gap-1.5">
            <KindIcon kind={u.agent.kind} />
            <span className="font-medium">{agentLabel(u.agent)}</span>
            {u.of > 1 && (
              <span className="text-muted">
                {u.ordinal} of {u.of}
              </span>
            )}
            <span className="font-mono font-semibold">{formatMoney(u.bucket.usd)}</span>
            {u.agent.model && <ModelName name={u.agent.model} className="text-meta text-faint" />}
            <span className="text-muted">
              launched in turn {u.launch}
              {u.returned ? `, report in turn ${u.ret}` : ', no report'}
              {u.nested.length > 0 &&
                `, ${plural(u.nested.length, 'sub-agent')} of its own (${formatMoney(u.nestedUSD)})`}
            </span>
            {u.compactions.length > 0 && (
              <span
                className={u.compactions.some((x) => x.compaction.call?.cache === 'cold') ? 'text-bad' : 'text-muted'}
              >
                compacted {plural(u.compactions.length, 'time')}
                {u.compactions.some((x) => x.compaction.call)
                  ? ` (~${formatMoney(u.compactions.reduce((s, x) => s + (x.compaction.call?.usd ?? 0), 0))})`
                  : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-x-3">
            <Chips parts={unitParts(u, split)} />
            <span className="min-w-0 flex-1 truncate text-muted">
              {firstLine(unwrapMachineText(u.asked).body) || u.agent.description}
            </span>
          </div>
        </>
      ) : (
        <>
          <div className="truncate text-muted">{c.prompt || '(no prompt text)'}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <Chips parts={stepParts(c, split)} />
            {c.step.rereads.map((r) => (
              <span key={r.at} className="text-muted">
                cache miss: {formatTokens(r.tokens)} written again
                {r.expired && r.gapMs !== undefined ? ` after ${formatDuration(r.gapMs)}` : ''}, cached it would have
                cost {formatMoney(r.cachedUSD)}
              </span>
            ))}
            {c.compactions.map((cp) => (
              <span key={cp.at} className={cp.call?.cache === 'cold' ? 'text-bad' : 'text-muted'}>
                compacted after it{cp.call ? `: ${callLine(cp.call)}` : ' (no estimate of its call)'}
              </span>
            ))}
            {c.typedWhileRunning > 0 && (
              <span className="text-muted">{plural(c.typedWhileRunning, 'prompt')} typed while it ran</span>
            )}
            {c.arrived.length > 0 && (
              <span className="text-muted">
                report from{' '}
                {c.arrived
                  .slice(0, 3)
                  .map((x) => agentLabel(x.agent))
                  .join(', ')}
                {c.arrived.length > 3 && ` and ${c.arrived.length - 3} more`}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** Where a branch is drawn. */
interface Band {
  top: number
  bracketTop: number
  stepsTop: number
  axisY: number
  rowTop: number[]
  bottom: number
}

export function SpendGraph({
  tree,
  home,
  pinned,
  onPin,
  selectedUnit,
  onSelectUnit,
  initialSplit = 'kind',
  initialCursor,
}: SpendGraphProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const width = useWidth(wrap)
  const [split, setSplit] = useState<Split>(initialSplit)
  const [cursor, setCursor] = useState<Pin | null>(
    initialCursor !== undefined && tree.branches[home]?.model.cols[initialCursor]
      ? { branch: home, col: initialCursor }
      : null,
  )
  const [hoverUnit, setHoverUnit] = useState<UnitRef | null>(null)

  const { branches } = tree
  const multi = branches.length > 1
  const focus = pinned?.branch ?? home
  const path = useMemo(() => pathPoints(tree, focus), [tree, focus])
  // the units worth a figure next to them: the few that stand out
  const labelled = useMemo(() => {
    const floor = 0.15 * Math.max(tree.maxUnit, tree.maxStep)
    return new Set(
      branches
        .flatMap((b) => b.model.units.map((u) => ({ id: `${b.index}/${u.id}`, usd: u.bucket.usd })))
        .filter((u) => u.usd >= floor && u.usd > 0)
        .sort((a, b) => b.usd - a.usd)
        .slice(0, 8)
        .map((u) => u.id),
    )
  }, [branches, tree.maxUnit, tree.maxStep])
  const topDecisions = useMemo(
    () =>
      new Set(
        branches
          .flatMap((b) => b.model.decisions.map((d) => ({ id: `${b.index}/${d.index}`, usd: d.usd })))
          .sort((a, b) => b.usd - a.usd)
          .slice(0, 3)
          .map((d) => d.id),
      ),
    [branches],
  )

  const compactions = useMemo(
    () => ({
      ...compactionTally(branches.flatMap((b) => [...b.model.compactions, ...b.model.agentCompactions])),
      inAgents: branches.reduce((n, b) => n + b.model.agentCompactions.length, 0),
    }),
    [branches],
  )

  if (branches.length === 0) return null

  const n = tree.slots
  const plotW = Math.max(40, width - ML - MR)
  const cw = plotW / n
  const x0 = (slot: number) => ML + slot * cw
  const xc = (slot: number) => ML + (slot + 0.5) * cw
  const px = SCALE_PX / Math.max(tree.maxStep, tree.maxUnit, 1e-9)
  const barW = cw >= 8 ? Math.min(cw - 2, 28) : cw >= 4 ? cw - 1 : cw
  const unitW = Math.max(3, Math.min(barW, 14))
  const unitH = (u: Unit) => Math.max(2, u.bucket.usd * px)

  // ---- vertical layout: the context, then a band per branch
  const ctxPts = path.filter((p) => p.tokens !== undefined)
  const hasCtx = ctxPts.length >= 2
  const ctxBase = CTX_TOP + CTX_H
  const bands: Band[] = []
  let yy = hasCtx ? ctxBase + TICKS_H + 14 : 6
  for (const b of branches) {
    const top = yy
    const bracketTop = top + TITLE_H
    const stepsTop = bracketTop + BRACKET_H
    const axisY = stepsTop + Math.max(STEP_MIN_H, b.model.maxStep * px + 12)
    const rowH: number[] = Array.from({ length: b.model.laneCount }, () => ROW_MIN)
    for (const r of b.model.rows)
      for (const u of r.units)
        rowH[r.lane] = Math.max(rowH[r.lane], unitH(u) + (labelled.has(`${b.index}/${u.id}`) ? LABEL_H : 0))
    const rowTop: number[] = []
    let ry = axisY + 14
    for (const h of rowH) {
      rowTop.push(ry)
      ry += h + ROW_GAP
    }
    const bottom = rowH.length ? ry - ROW_GAP + 4 : axisY + 8
    bands.push({ top, bracketTop, stepsTop, axisY, rowTop, bottom })
    yy = bottom + BAND_GAP
  }
  const height = yy - BAND_GAP + (hasCtx ? 4 : TICKS_H)

  // ---- context scale, along the path to the branch in focus
  const marks = pathTo(tree, focus).flatMap((b) =>
    (b.detail.digest.compactions ?? []).flatMap((c) => {
      const slot = b.slot[c.turn]
      // only the compactions on the part of the branch the path runs through
      return slot !== undefined && path.some((p) => p.branch === b.index && p.col === c.turn)
        ? [
            {
              slot: slot + 0.5,
              turn: c.turn,
              pre: c.preTokens,
              trigger: c.trigger,
              call: c.call,
              key: `${b.index}/${c.at}`,
            },
          ]
        : []
    }),
  )
  const ctxMax = Math.max(
    1,
    ...path.map((p) => Math.max(p.tokens ?? 0, p.rereadTokens)),
    ...marks.map((m) => m.pre ?? 0),
  )
  const cTicks = niceTicks(ctxMax, 2)
  const cTop = cTicks[cTicks.length - 1]
  const yc = (v: number) => ctxBase - (Math.min(v, cTop) / cTop) * CTX_H
  const ctxLine = ctxPts.map((p, i) => `${i ? 'L' : 'M'}${f1(xc(p.slot))} ${f1(yc(p.tokens ?? 0))}`).join('')
  const xTicks = niceTicks(n - 1, Math.max(2, Math.floor(plotW / 90))).filter((t) => t <= n - 1)

  // ---- what is under the cursor, pinned, selected
  const valid = (p: Pin | null): p is Pin => !!p && !!branches[p.branch]?.model.cols[p.col]
  const cur = valid(cursor) ? cursor : undefined
  const shown = cur ?? (valid(pinned) ? pinned : undefined)
  const unitOf = (r: UnitRef | null) => {
    const branch = r ? branches[r.branch] : undefined
    const unit = branch?.model.units.find((u) => u.id === r?.id)
    return branch && unit ? { branch, unit } : undefined
  }
  const shownUnit = unitOf(hoverUnit) ?? (cur ? undefined : unitOf(selectedUnit))
  const isOn = (b: Branch, u: Unit) =>
    (hoverUnit?.branch === b.index && hoverUnit.id === u.id) ||
    (selectedUnit?.branch === b.index && selectedUnit.id === u.id)
  const expired = tree.rereads.filter((r) => r.expired).length

  const at = (clientX: number, clientY: number, el: HTMLElement): Pin | null => {
    const r = el.getBoundingClientRect()
    const y = clientY - r.top
    // the band under the pointer; above the first one (the context), the branch in focus
    let bi = bands.findIndex(
      (g, i) => y < g.bottom + (i === bands.length - 1 ? Number.POSITIVE_INFINITY : BAND_GAP / 2),
    )
    if (y < bands[0].top) bi = focus
    const b = branches[bi]
    if (!b || b.own.length === 0) return null
    const slot = Math.min(b.last, Math.max(b.first, Math.floor((clientX - r.left - ML) / cw)))
    const col = b.colAt.get(slot)
    return col === undefined ? null : { branch: bi, col }
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => setCursor(at(e.clientX, e.clientY, e.currentTarget))
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const here = cur ?? (valid(pinned) ? pinned : undefined)
    const b = branches[here?.branch ?? focus]
    if (!b || b.own.length === 0) return
    const k = here ? b.own.indexOf(here.col) : b.own.length - 1
    const big = e.shiftKey ? 10 : 1
    let next: number
    if (e.key === 'ArrowLeft') next = k - big
    else if (e.key === 'ArrowRight') next = here ? k + big : b.own.length - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = b.own.length - 1
    else if (e.key === 'Escape') {
      onPin(null)
      return
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (cur) onPin(cur)
      return
    } else return
    e.preventDefault()
    setCursor({ branch: b.index, col: b.own[Math.min(b.own.length - 1, Math.max(0, next))] })
  }

  const caption = (text: string, x: number, y: number, anchor: 'start' | 'end' = 'start') => (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fontSize={10}
      fill="var(--faint)"
      style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}
    >
      {text}
    </text>
  )
  /** A bar of stacked parts starting at `from` and growing by `dir` (-1 up, 1 down). */
  const stack = (parts: Part[], x: number, w: number, from: number, dir: 1 | -1, minH: number) => {
    const sum = parts.reduce((s, p) => s + Math.max(0, p.usd), 0)
    if (sum <= 0) return null
    const total = Math.max(minH, sum * px)
    let off = 0
    return parts.map((p) => {
      if (p.usd <= 0) return null
      const h = (p.usd / sum) * total
      const y = dir === 1 ? from + off : from - off - h
      off += h
      return <rect key={p.key} x={x} y={y} width={w} height={Math.max(h, 0.5)} fill={p.color} />
    })
  }
  const highlight = (p: Pin, fill: string, opacity: number) => {
    const b = branches[p.branch]
    const g = bands[p.branch]
    const slot = b.slot[p.col]
    if (slot === undefined) return null
    const inPath = path.some((q) => q.branch === p.branch && q.col === p.col)
    return (
      <g pointerEvents="none">
        {hasCtx && inPath && (
          <rect x={x0(slot)} y={CTX_TOP} width={Math.max(cw, 2)} height={CTX_H} fill={fill} opacity={opacity} />
        )}
        <rect
          x={x0(slot)}
          y={g.bracketTop}
          width={Math.max(cw, 2)}
          height={g.bottom - g.bracketTop}
          fill={fill}
          opacity={opacity}
        />
      </g>
    )
  }

  /** Every turn of the decision a turn belongs to, tinted: the bars inside are what its total is made of. */
  const span = (p: Pin) => {
    const b = branches[p.branch]
    const g = bands[p.branch]
    const dec = b.model.decisions[b.model.cols[p.col].decision]
    const own = b.own.filter((i) => i >= dec.start && i <= dec.end)
    if (own.length < 2) return null
    const xa = x0(b.slot[own[0]] ?? b.first)
    const xb = x0(b.slot[own[own.length - 1]] ?? b.first) + cw
    return (
      <rect
        x={xa}
        y={g.bracketTop}
        width={xb - xa}
        height={g.bottom - g.bracketTop}
        fill="var(--accent)"
        opacity={0.07}
        pointerEvents="none"
      />
    )
  }

  const drawBranch = (b: Branch) => {
    const g = bands[b.index]
    const m = b.model
    const sx = (col: number) => b.slot[col] ?? b.first
    const startX = x0(b.first)
    const endX = b.own.length ? x0(b.last) + cw : startX + 8
    const parent = b.parent !== undefined ? bands[b.parent] : undefined
    const bar = (u: Unit): [number, number] => [xc(sx(u.launch)) - unitW / 2, xc(sx(u.launch)) + unitW / 2]
    const tail = (u: Unit): number | undefined =>
      u.ret > u.launch ? Math.max(x0(sx(u.ret)), xc(sx(u.launch)) + unitW / 2 + 2) : undefined
    const reach = (u: Unit) => tail(u) ?? bar(u)[1]
    const laneOf = new Map(m.rows.map((r) => [r.agent.id, r.lane]))
    const sTicks = niceTicks(m.maxStep || 1, 2).filter((t) => t > 0 && t * px <= g.axisY - g.stepsTop - 6)
    const whole = sTicks.every((t) => Number.isInteger(t))
    const active = shown?.branch === b.index ? m.cols[shown.col].decision : -1
    const held = valid(pinned) && pinned.branch === b.index ? m.cols[pinned.col].decision : -1
    // the title sits over the start of the line, pulled left when it would run off the plot
    const title = `${b.title} · ${formatMoney(m.total)}`
    const titleW = Math.min(title.length * 6.2, plotW)
    const titleX = Math.max(ML, Math.min(startX, width - MR - titleW))

    return (
      <g key={b.index}>
        {/* where it left its parent */}
        {parent && (
          <path
            d={`M${f1(startX)} ${parent.axisY}V${g.axisY - 7}Q${f1(startX)} ${g.axisY} ${f1(startX + 7)} ${g.axisY}`}
            fill="none"
            stroke="var(--text)"
            strokeWidth={1.25}
          >
            <title>{b.kind === 'continuation' ? 'continued in a new session' : 'forked into a new session'}</title>
          </path>
        )}
        {multi ? (
          <text x={titleX} y={g.top + 11} fontSize={11} fontWeight={600} fill="var(--text)">
            {title.length * 6.2 > plotW ? `${title.slice(0, Math.floor(plotW / 6.2) - 1)}…` : title}
          </text>
        ) : (
          caption('main agent, per turn', ML, g.top + 11)
        )}

        {/* decisions: a prompt someone typed, and the turns that followed from it */}
        {m.decisions.map((dec) => {
          if (dec.usd <= 0 || m.cols[dec.end].inherited) return null
          // a decision that starts on a copied turn is drawn from the branch's first own turn
          const xa = x0(m.cols[dec.start].inherited ? b.first : sx(dec.start)) + 1.5
          const xb = x0(sx(dec.end)) + cw - 1.5
          const y = g.stepsTop - 6
          const pin = dec.index === held
          const on = dec.index === active || pin
          const big = topDecisions.has(`${b.index}/${dec.index}`)
          return (
            <g key={dec.index} pointerEvents="none">
              <path
                d={`M${f1(xa)} ${y + 3}V${y}H${f1(xb)}V${y + 3}`}
                fill="none"
                stroke={pin ? 'var(--accent)' : on ? 'var(--text)' : 'var(--faint)'}
                strokeWidth={pin ? 2 : 1}
              />
              {(xb - xa >= 34 || on) && (
                <text
                  x={(xa + xb) / 2}
                  y={y - 3}
                  textAnchor="middle"
                  fontSize={10}
                  fontWeight={big || on ? 600 : 400}
                  fill={big || on ? 'var(--text)' : 'var(--muted)'}
                  stroke="var(--surface)"
                  strokeWidth={3}
                  paintOrder="stroke"
                >
                  {formatMoney(dec.usd)}
                </text>
              )}
            </g>
          )
        })}

        {/* steps: what the main agent spent in each turn */}
        {sTicks.map((t) => (
          <g key={t}>
            <line
              x1={startX}
              x2={endX}
              y1={g.axisY - t * px}
              y2={g.axisY - t * px}
              stroke="var(--line)"
              strokeWidth={1}
            />
            <text
              x={Math.max(ML, startX) - 5}
              y={g.axisY - t * px}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={10}
              fill="var(--muted)"
            >
              {whole ? `$${formatCount(t)}` : formatMoney(t)}
            </text>
          </g>
        ))}
        {b.own.map((i) => (
          <g key={i}>{stack(stepParts(m.cols[i], split), xc(sx(i)) - barW / 2, barW, g.axisY - 1, -1, 1)}</g>
        ))}

        {/* the connectors: where a unit branches off, and where its report comes back */}
        {m.units.map((u) => {
          const y = g.rowTop[laneOf.get(u.agent.id) ?? 0]
          const color = KIND_COLOR[u.agent.kind]
          const on = isOn(b, u)
          const xt = tail(u)
          const xl = xc(sx(u.launch))
          return (
            <g key={u.id} pointerEvents="none" opacity={on ? 1 : 0.3}>
              <line x1={xl} x2={xl} y1={g.axisY} y2={y} stroke={color} strokeWidth={on ? 1.5 : 1} />
              {xt !== undefined && u.returned && (
                <>
                  <line
                    x1={xt}
                    x2={xt}
                    y1={y}
                    y2={g.axisY + 5}
                    stroke={color}
                    strokeWidth={on ? 1.5 : 1}
                    strokeDasharray="2 2"
                  />
                  <path
                    d={`M${f1(xt - 2.5)} ${g.axisY + 5.5}L${f1(xt)} ${g.axisY + 1.5}L${f1(xt + 2.5)} ${g.axisY + 5.5}Z`}
                    fill={color}
                  />
                </>
              )}
            </g>
          )
        })}

        {/* compactions: after the turn they followed, red when the cache had gone cold */}
        {b.own.flatMap((i) =>
          m.cols[i].compactions.map((cp) => {
            const x = x0(sx(i)) + cw
            const cold = cp.call?.cache === 'cold'
            return (
              <g key={`k${cp.at}`} pointerEvents="none">
                <line
                  x1={x}
                  x2={x}
                  y1={g.stepsTop - 2}
                  y2={g.axisY}
                  stroke={markColor(cp.call)}
                  strokeWidth={cold ? 2 : 1.25}
                  strokeDasharray={cold ? undefined : '3 2'}
                />
                {cp.call && (cold || cp.call.usd >= 1) && (
                  <text
                    x={x + 3}
                    y={g.stepsTop + 8}
                    fontSize={9}
                    fontWeight={cold ? 600 : 400}
                    fill={cold ? 'var(--bad)' : 'var(--muted)'}
                    stroke="var(--surface)"
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    ~{formatMoney(cp.call.usd)}
                    {cold ? ` cold, ${idleText(cp.call.idleMs)} idle` : ''}
                  </text>
                )}
              </g>
            )
          }),
        )}

        {/* the line: a dot for every prompt a person typed */}
        <line
          x1={parent ? startX + 7 : startX}
          x2={endX}
          y1={g.axisY}
          y2={g.axisY}
          stroke="var(--text)"
          strokeWidth={1.25}
        />
        {b.own.map((i) => {
          const c = m.cols[i]
          return (
            <g key={i}>
              {c.human && (
                <circle
                  cx={xc(sx(i))}
                  cy={g.axisY}
                  r={cw >= 5 ? 2.4 : 1.8}
                  fill="var(--text)"
                  stroke="var(--surface)"
                  strokeWidth={1}
                />
              )}
              {c.typedWhileRunning > 0 && (
                <circle
                  cx={xc(sx(i))}
                  cy={g.axisY}
                  r={cw >= 5 ? 4.4 : 3.4}
                  fill="none"
                  stroke="var(--text)"
                  strokeWidth={1}
                />
              )}
              {c.turn.abandoned && <rect x={x0(sx(i))} y={g.axisY + 2} width={cw} height={2} fill="var(--faint)" />}
            </g>
          )
        })}
        {b.own.length === 0 && (
          <text x={startX + 12} y={g.axisY + 4} fontSize={10} fill="var(--faint)">
            no turns of its own
          </text>
        )}

        {/* agents: a row each, a bar per piece of work */}
        {m.rows.map((r) => {
          const y = g.rowTop[r.lane]
          const color = KIND_COLOR[r.agent.kind]
          const end = Math.max(...r.units.map(reach))
          const next = m.rows
            .filter((o) => o.lane === r.lane && o.first > r.last)
            .reduce((x, o) => Math.min(x, bar(o.units[0])[0]), width - MR)
          const name = agentLabel(r.agent)
          return (
            <g key={r.agent.id}>
              <line
                x1={bar(r.units[0])[0]}
                x2={end}
                y1={y + 0.5}
                y2={y + 0.5}
                stroke={color}
                strokeWidth={1}
                opacity={0.3}
              />
              {r.units.map((u) => {
                const [ua, ub] = bar(u)
                const xt = tail(u)
                const h = unitH(u)
                const on = isOn(b, u)
                return (
                  // biome-ignore lint/a11y/useSemanticElements: an SVG mark cannot be a button element
                  <g
                    key={u.id}
                    role="button"
                    tabIndex={-1}
                    className="cursor-pointer"
                    onPointerEnter={() => setHoverUnit({ branch: b.index, id: u.id })}
                    onPointerLeave={() => setHoverUnit(null)}
                    onClick={(e) => {
                      e.stopPropagation()
                      onSelectUnit({ branch: b.index, id: u.id })
                    }}
                  >
                    <rect
                      x={ua - 1.5}
                      y={y - 3}
                      width={Math.max((xt ?? ub) - ua + 3, 7)}
                      height={Math.max(h, ROW_MIN) + 5}
                      fill="transparent"
                    />
                    {xt !== undefined && (
                      <line
                        x1={ub}
                        x2={xt}
                        y1={y + 1}
                        y2={y + 1}
                        stroke={color}
                        strokeWidth={on ? 2.5 : 2}
                        opacity={on ? 1 : 0.75}
                      />
                    )}
                    {stack(unitParts(u, split), ua, ub - ua, y, 1, 2)}
                    {u.compactions.map((x) => {
                      const cx = Math.min(xt ?? ub, Math.max(ua, xc(sx(x.turn))))
                      const cold = x.compaction.call?.cache === 'cold'
                      return (
                        <line
                          key={`${x.agent.id}${x.compaction.at}`}
                          x1={cx}
                          x2={cx}
                          y1={y - 3}
                          y2={y + 6}
                          stroke={markColor(x.compaction.call)}
                          strokeWidth={cold ? 2.5 : 2}
                          pointerEvents="none"
                        />
                      )
                    })}
                    {on && (
                      <rect
                        x={ua - 1}
                        y={y - 1}
                        width={ub - ua + 2}
                        height={h + 2}
                        fill="none"
                        stroke="var(--text)"
                        strokeWidth={1.25}
                      />
                    )}
                    {labelled.has(`${b.index}/${u.id}`) && (
                      <text
                        x={(ua + ub) / 2}
                        y={y + h + 9}
                        textAnchor="middle"
                        fontSize={9}
                        fill="var(--text)"
                        stroke="var(--surface)"
                        strokeWidth={3}
                        paintOrder="stroke"
                      >
                        {formatMoney(u.bucket.usd)}
                      </text>
                    )}
                  </g>
                )
              })}
              {next - end >= name.length * 5.2 + 10 && (
                <text x={end + 4} y={y + 4} dominantBaseline="central" fontSize={9} fill="var(--muted)">
                  {name}
                </text>
              )}
            </g>
          )
        })}
      </g>
    )
  }

  return (
    <Card
      title="Spend"
      actions={
        <SegmentedControl
          label="How a bar is split"
          value={split}
          onChange={setSplit}
          options={[
            { value: 'kind', label: 'By who', title: 'Main agent, agents by kind, cache misses' },
            { value: 'class', label: 'By token class', title: 'Output, cache reads and writes, uncached input' },
          ]}
        />
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sec">
        {(split === 'kind' ? tree.byKind : tree.byClass).map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1.5">
            <Swatch color={p.color} />
            <span>{p.label}</span>
            <span className="font-mono">{formatMoney(p.usd)}</span>
            <span className="text-faint">{formatPercent(p.usd, tree.total)}</span>
          </span>
        ))}
      </div>
      {compactions.calls + compactions.unknown > 0 && (
        <p className="mb-2 flex flex-wrap items-center gap-x-2 text-sec">
          <span aria-hidden className="inline-block h-3 w-0 border-l-2 border-bad" />
          <span className={compactions.cold > 0 ? 'text-bad' : undefined}>
            Compactions: {compactions.calls > 0 ? tallyLine(compactions) : `${compactions.unknown}`}
          </span>
          {compactions.cold > 0 && <span className="text-muted">({warmLine(compactions)})</span>}
          {compactions.inAgents > 0 && (
            <span className="text-muted">{compactions.inAgents} of them inside agents' own conversations.</span>
          )}
          <span className="text-muted">
            {compactions.unknown > 0 && compactions.calls > 0 && `${compactions.unknown} more without an estimate. `}
            {compactions.calls > 0
              ? 'Estimated, since the harness does not record the call; not in any figure on this page.'
              : 'The harness recorded no estimate of their calls.'}
          </span>
        </p>
      )}
      <Readout tree={tree} at={shown} unit={shownUnit} split={split} />
      <div
        ref={wrap}
        role="slider"
        tabIndex={0}
        aria-label="Spend per turn and per piece of agent work"
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={shown ? (branches[shown.branch].slot[shown.col] ?? 0) : 0}
        aria-valuetext={
          shown
            ? `${branches[shown.branch].title}, turn ${shown.col}, ${formatMoney(branches[shown.branch].model.cols[shown.col].usd)}`
            : undefined
        }
        onPointerMove={onMove}
        onPointerLeave={(e) => {
          if (document.activeElement !== e.currentTarget) setCursor(null)
          setHoverUnit(null)
        }}
        onBlur={() => setCursor(null)}
        onClick={(e) => {
          const p = at(e.clientX, e.clientY, e.currentTarget)
          if (p) onPin(p)
        }}
        onKeyDown={onKey}
        className="mt-1 cursor-crosshair rounded-badge"
      >
        <svg width={width} height={height} role="img" aria-label="Spend over the turns" className="block">
          {/* context along the path to the branch in focus */}
          {hasCtx && (
            <g>
              {caption(multi ? `context · ${branches[focus].title}` : 'context of the main session', ML, CTX_TOP - 7)}
              {cTicks.map((t) => (
                <g key={t}>
                  <line x1={ML} x2={width - MR} y1={yc(t)} y2={yc(t)} stroke="var(--line)" strokeWidth={1} />
                  <text
                    x={ML - 5}
                    y={yc(t)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fontSize={10}
                    fill="var(--muted)"
                  >
                    {t === 0 ? '0' : formatTokens(t)}
                  </text>
                </g>
              ))}
              <path
                d={`${ctxLine}L${f1(xc(ctxPts[ctxPts.length - 1].slot))} ${ctxBase}L${f1(xc(ctxPts[0].slot))} ${ctxBase}Z`}
                fill="var(--accent)"
                opacity={0.12}
              />
              {path.map(
                (p) =>
                  p.rereadTokens > 0 && (
                    <rect
                      key={`${p.branch}/${p.col}`}
                      x={xc(p.slot) - Math.max(2, Math.min(cw - 1, 10)) / 2}
                      y={yc(p.rereadTokens)}
                      width={Math.max(2, Math.min(cw - 1, 10))}
                      height={ctxBase - yc(p.rereadTokens)}
                      fill="var(--series-5)"
                    />
                  ),
              )}
              <path d={ctxLine} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinejoin="round" />
              {marks.map((m) => (
                <g key={m.key}>
                  <title>{`compaction after turn ${m.turn}${m.trigger ? ` (${m.trigger})` : ''}${m.call ? `: ${callLine(m.call)}` : ''}`}</title>
                  <line
                    x1={xc(m.slot)}
                    x2={xc(m.slot)}
                    y1={CTX_TOP - 4}
                    y2={ctxBase}
                    stroke={markColor(m.call)}
                    strokeWidth={m.call?.cache === 'cold' ? 2 : 1.5}
                    strokeDasharray={m.call?.cache === 'cold' ? undefined : '3 2'}
                  />
                </g>
              ))}
              {/* where the path changes branch */}
              {pathTo(tree, focus)
                .slice(1)
                .map((b) => (
                  <line
                    key={b.index}
                    x1={x0(b.first)}
                    x2={x0(b.first)}
                    y1={CTX_TOP}
                    y2={ctxBase}
                    stroke="var(--text)"
                    strokeWidth={1}
                    opacity={0.5}
                  >
                    <title>{`${b.kind === 'continuation' ? 'continued' : 'forked'} here: ${b.title}`}</title>
                  </line>
                ))}
            </g>
          )}
          {xTicks.map((t) => (
            <text
              key={t}
              x={xc(t)}
              y={hasCtx ? ctxBase + 12 : height - 4}
              textAnchor="middle"
              fontSize={10}
              fill="var(--muted)"
            >
              {t}
            </text>
          ))}

          {branches.map(drawBranch)}

          {valid(pinned) && (
            <>
              {span(pinned)}
              {highlight(pinned, 'var(--accent)', 0.14)}
              <path
                d={`M${f1(xc(branches[pinned.branch].slot[pinned.col] ?? 0) - 4)} ${bands[pinned.branch].bracketTop - 7}h8l-4 6z`}
                fill="var(--accent)"
                pointerEvents="none"
              />
            </>
          )}
          {cur && highlight(cur, 'var(--text)', 0.08)}
        </svg>
      </div>
      <p className="mt-2 text-meta text-muted">
        {multi &&
          'Each line is a session: one forked or continued from another starts where it left it, and only its own turns are on it. '}
        Above a line, a bar is what the main agent spent in that turn. Below it, a bar is one piece of work handed to an
        agent, under the turn that launched it and as tall as everything it cost (its own sub-agents included); the tail
        runs to the turn its report came in. All bars are on one dollar scale. A dot is a prompt you typed, a ring one
        you typed while a turn ran; the bracket above it totals everything up to your next one, and a click tints those
        turns. A red mark is a compaction on a cold cache, an amber dashed one on a warm cache; a short mark on an
        agent's bar is a compaction of that agent's own conversation. Dollars are recomputed from token counts
        {tree.fromMessages ? '' : '; this daemon sent no messages, so the token classes and cache misses are missing'}.
        {tree.rereads.length > 0 &&
          ` ${plural(tree.rereads.length, 'cache miss', 'cache misses')} (context that had been cached and was written again): ${expired} after the cache had expired, ${tree.rereads.length - expired} sooner.`}
      </p>
    </Card>
  )
}
