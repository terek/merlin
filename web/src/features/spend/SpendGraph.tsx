// The spend graph: the card around the time view (TimeView.tsx), with the legend, the compactions,
// the readout of what is under the cursor and the key handling. The pinned turn and the selected
// piece of agent work are the page's; the panels under the card open them.
import { type KeyboardEvent, useMemo, useRef, useState } from 'react'
import { usePrices } from '../../api/queries'
import type { SessionKey } from '../../api/types'
import { approx, callLine, tallyLine, warmLine } from '../../lib/compaction'
import { formatCount, formatDuration, formatMoney, formatTokens, plural } from '../../lib/format'
import { firstLine } from '../../lib/paths'
import { unwrapMachineText } from '../../lib/wrapper'
import { Card, ModelName } from '../../ui'
import { KindIcon } from '../agents/AgentRow'
import { agentLabel } from '../agents/model'
import { Breakdown } from './Breakdown'
import { keyFacts, Legend, LegendButton, useLegendOpen } from './Key'
import { kindColor } from './marks'
import {
  compactionTally,
  missText,
  type Part,
  stepParts,
  turnList,
  type Unit,
  unitParts,
  unitUnrecorded,
} from './model'
import { Overview, stripAxis } from './Overview'
import { TimePlot } from './TimeView'
import {
  boundsOf,
  buildTimeline,
  clampWindow,
  defaultWindow,
  effectiveWindow,
  revealWindow,
  splitDays,
  type Win,
} from './timeline'
import type { Branch, Tree } from './tree'
import { useWidth } from './useWidth'

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
  /** The branch the page was opened on: the keys move along it until something else is pinned. */
  home: number
  /** The turn the inspector shows. */
  pinned: Pin | null
  onPin: (pin: Pin | null) => void
  selectedUnit: UnitRef | null
  onSelectUnit: (unit: UnitRef) => void
  /** Dev and screenshots: start with the cursor on this turn of the home branch. */
  initialCursor?: number
  /** Dev and screenshots: the window of time to show first (`?from=&to=`). */
  initialWindow?: Partial<Win>
  /** The session the page is about: its main row is marked in the plot. */
  current?: SessionKey
}

const pinKey = (p: Pin | null | undefined) => (p ? `${p.branch}/${p.col}` : '')

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

/** The lines of the readout that say which turn or piece of work is under the cursor (the plot's own readout holds them). */
function TurnReadout({
  tree,
  at,
  unit,
}: {
  tree: Tree
  at: Pin | undefined
  unit: { branch: Branch; unit: Unit } | undefined
}) {
  const b = unit ? unit.branch : tree.branches[at?.branch ?? 0]
  const c = b.model.cols[unit ? unit.unit.launch : (at?.col ?? 0)]
  const dec = b.model.decisions[c.decision]
  const launchedUSD = c.launched.reduce((s, u) => s + u.bucket.usd, 0)
  const u = unit?.unit
  const notes = [
    ...c.step.rereads.map((r) => ({
      key: `r${r.at}`,
      cls: 'text-muted',
      text: `cache miss: ${formatTokens(r.tokens)} billed again ${missText(r)}, cached it would have cost ${formatMoney(r.cachedUSD)}`,
    })),
    ...c.compactions.map((cp) => ({
      key: `c${cp.at}`,
      cls: cp.call?.cache === 'cold' ? 'text-bad' : 'text-muted',
      text: `compacted after it${cp.call ? `: ${callLine(cp.call, !!cp.messageId)}` : ' (no estimate of its call)'}`,
    })),
    ...(c.typedWhileRunning > 0
      ? [{ key: 'typed', cls: 'text-muted', text: `${plural(c.typedWhileRunning, 'prompt')} typed while it ran` }]
      : []),
    ...(c.arrived.length > 0
      ? [
          {
            key: 'arrived',
            cls: 'text-muted',
            text: `report from ${c.arrived
              .slice(0, 3)
              .map((x) => agentLabel(x.agent))
              .join(', ')}${c.arrived.length > 3 ? ` and ${c.arrived.length - 3} more` : ''}`,
          },
        ]
      : []),
  ]
  return (
    // one line each, so that what is under the pointer never moves the graph
    <div className="mt-0.5 space-y-0.5 text-sec text-text">
      <div className="flex items-baseline gap-x-3 overflow-hidden whitespace-nowrap">
        {tree.branches.length > 1 && <span className="max-w-64 truncate font-medium">{b.title}</span>}
        <span className="font-mono">turn {c.index}</span>
        <span title="what the main agent spent in this turn">
          step <span className="font-mono font-semibold">{formatMoney(c.usd)}</span>
        </span>
        {c.launched.length > 0 && (
          <span title="work handed to agents in this turn, at its full cost">
            launched {c.launched.length} ·{' '}
            {c.launched.every((x) => x.agent.unrecorded) ? (
              <span className="text-muted">not recorded</span>
            ) : (
              <span className="font-mono font-semibold">
                {c.launched.some((x) => x.agent.unrecorded) ? '≥' : ''}
                {formatMoney(launchedUSD)}
              </span>
            )}
          </span>
        )}
        {dec.end > dec.start && (
          <span className="text-muted" title="everything between the prompt you typed and your next one">
            turns {dec.start}–{dec.end} together:{' '}
            <span className="font-mono">
              {dec.unrecordedRuns > 0 ? '≥' : ''}
              {formatMoney(dec.usd)}
            </span>
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
          <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
            <KindIcon agent={u.agent} color={kindColor(u.agent)} />
            <span className="font-medium">{agentLabel(u.agent)}</span>
            {u.of > 1 && (
              <span className="text-muted">
                {u.ordinal} of {u.of}
              </span>
            )}
            {u.agent.unrecorded && u.bucket.usd === 0 ? (
              <span className="text-muted">not recorded</span>
            ) : (
              <span className="font-mono font-semibold">
                {u.bucket.unpriced > 0 || unitUnrecorded(u) > 0 ? '≥' : u.bucket.estimated > 0 ? '~' : ''}
                {formatMoney(u.bucket.usd)}
              </span>
            )}
            {u.agent.model && <ModelName name={u.agent.model} className="text-meta text-faint" />}
            <span className="text-muted">
              launched in turn {u.launch}
              {u.returned
                ? `, ${u.reports.length > 1 ? 'reports' : 'report'} in ${turnList(u.reports)}`
                : ', no report'}
              {u.nested.length > 0 &&
                `, ${plural(u.nested.length, 'sub-agent')} of its own (${u.nested.some((x) => x.unrecorded) ? '≥' : ''}${formatMoney(u.nestedUSD)})`}
            </span>
            {u.compactions.length > 0 && (
              <span
                className={u.compactions.some((x) => x.compaction.call?.cache === 'cold') ? 'text-bad' : 'text-muted'}
              >
                compacted {plural(u.compactions.length, 'time')}
                {u.compactions.some((x) => x.compaction.call)
                  ? ` (${approx(u.compactions.every((x) => x.compaction.messageId))}${formatMoney(u.compactions.reduce((s, x) => s + (x.compaction.call?.usd ?? 0), 0))})`
                  : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-x-3">
            <Chips parts={unitParts(u, 'kind')} />
            <span className="min-w-0 flex-1 truncate text-muted">
              {firstLine(unwrapMachineText(u.asked).body) || u.agent.description}
            </span>
          </div>
        </>
      ) : (
        <>
          <div className="truncate text-muted">{c.prompt || '(no prompt text)'}</div>
          <div className="flex items-center gap-x-3 overflow-hidden whitespace-nowrap">
            <Chips parts={stepParts(c, 'kind')} />
            {notes.length > 0 && (
              <span className="min-w-0 flex-1 truncate" title={notes.map((n) => n.text).join('\n')}>
                {notes.map((n) => (
                  <span key={n.key} className={`mr-3 ${n.cls}`}>
                    {n.text}
                  </span>
                ))}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export function SpendGraph({
  tree,
  home,
  pinned,
  onPin,
  selectedUnit,
  onSelectUnit,
  initialCursor,
  initialWindow,
  current,
}: SpendGraphProps) {
  const [cursor, setCursor] = useState<Pin | null>(
    initialCursor !== undefined && tree.branches[home]?.model.cols[initialCursor]
      ? { branch: home, col: initialCursor }
      : null,
  )
  const [hoverUnit, setHoverUnit] = useState<UnitRef | null>(null)
  const [legendOpen, setLegendOpen] = useLegendOpen()

  const { branches } = tree
  const focus = pinned?.branch ?? home
  // agent runs that left no record of their spend (a Pi `--no-session` child): unknown, so in no figure
  const unrecordedRuns = branches.reduce((n, b) => n + (b.detail.digest.cost.unrecordedAgents ?? 0), 0)
  const compactions = useMemo(
    () => ({
      ...compactionTally(branches.flatMap((b) => [...b.model.compactions, ...b.model.agentCompactions])),
      inAgents: branches.reduce((n, b) => n + b.model.agentCompactions.length, 0),
    }),
    [branches],
  )

  // a tree is shown a window at a time, picked in the overview (a short one opens on all of it)
  const prices = usePrices().data?.models // until it arrives (or if it fails) tiers go by the model's family
  const timeline = useMemo(() => buildTimeline(tree, prices), [tree, prices])
  const facts = useMemo(() => keyFacts(tree, timeline), [tree, timeline])
  const days = useMemo(() => splitDays(timeline), [timeline])
  const bounds = useMemo(() => boundsOf(timeline), [timeline])
  const turnStart = (p: Pin | null | undefined) =>
    (p && timeline.lanes.find((l) => l.main && l.branch === p.branch)?.turns.find((x) => x.col.index === p.col)?.t0) ||
    Number.NaN
  const latest = useMemo(() => defaultWindow(timeline, days), [timeline, days])
  const [win, setWin] = useState<Win>(() => {
    if (initialWindow && (initialWindow.lo !== undefined || initialWindow.hi !== undefined))
      return clampWindow({ lo: initialWindow.lo ?? bounds.t0, hi: initialWindow.hi ?? bounds.t1 }, bounds)
    // a session opens on all of it; "Latest" is a click away
    return { lo: bounds.t0, hi: bounds.t1 }
  })
  // what the plot shows is measured on the strip the brush is dragged on, so the strip's width is known here
  const stripRef = useRef<HTMLDivElement>(null)
  const stripWidth = useWidth(stripRef)
  const strip = useMemo(() => stripAxis(timeline, stripWidth), [timeline, stripWidth])
  const eff = useMemo(() => effectiveWindow(timeline, win, (a, b) => strip.x(b) - strip.x(a)), [timeline, win, strip])
  // the window is the user's: only what they do to it moves it. A turn they pin (in a panel, in the list
  // of decisions) or reach with the keys brings itself into view when the plot does not show it; the
  // pointer passing over the plot never moves it.
  const reveal = (t: number) => {
    if (!Number.isFinite(t) || (t >= eff.lo && t < eff.hi)) return
    const next = revealWindow(win, t, days, bounds)
    if (next !== win) setWin(next)
  }
  const [seen, setSeen] = useState(pinKey(pinned))
  if (seen !== pinKey(pinned)) {
    setSeen(pinKey(pinned))
    reveal(turnStart(pinned))
  }

  if (branches.length === 0) return null

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
    const to = { branch: b.index, col: b.own[Math.min(b.own.length - 1, Math.max(0, next))] }
    setCursor(to)
    reveal(turnStart(to))
  }

  return (
    <Card title="Spend" actions={<LegendButton open={legendOpen} onToggle={() => setLegendOpen(!legendOpen)} />}>
      {/* the legend is a column on the right: what is left of the width is the content's, and the
          plot and the strip measure it, so they follow when the column opens or closes */}
      <div className="flex items-stretch gap-3">
        <div className="min-w-0 flex-1">
          <Breakdown tree={tree} timeline={timeline} range={eff} />
          {unrecordedRuns > 0 && (
            <p
              className="mb-2 flex items-center gap-1.5 text-sec text-muted"
              title="The harness kept no record of these agents' calls, so their spend is unknown, not $0. Every figure here is at least that much; the percentages are of the spend that is known."
            >
              <span aria-hidden className="inline-block h-0 w-2.5 shrink-0 border-t border-dashed border-muted" />
              <span>{plural(unrecordedRuns, 'sub-agent run')} not recorded</span>
            </p>
          )}
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
                {compactions.unknown > 0 &&
                  compactions.calls > 0 &&
                  `${compactions.unknown} more without an estimate. `}
                {compactions.calls === 0
                  ? 'The harness recorded no estimate of their calls.'
                  : compactions.recorded === compactions.calls
                    ? 'Recorded by the harness; already in the figures on this page.'
                    : 'Estimated, since the harness does not record the call; not in any figure on this page.'}
              </span>
            </p>
          )}
          <div ref={stripRef}>
            <Overview
              timeline={timeline}
              days={days}
              win={win}
              eff={eff}
              onWin={setWin}
              pinnedT={turnStart(pinned)}
              latest={latest}
            />
          </div>
          <div className="relative">
            <TimePlot
              tree={tree}
              timeline={timeline}
              range={eff}
              pinned={valid(pinned) ? pinned : null}
              cursor={cur}
              selectedUnit={selectedUnit}
              hoverUnit={hoverUnit}
              onCursor={setCursor}
              onHoverUnit={setHoverUnit}
              onPin={onPin}
              onSelectUnit={onSelectUnit}
              onKey={onKey}
              current={current}
              turnLines={shown || shownUnit ? <TurnReadout tree={tree} at={shown} unit={shownUnit} /> : null}
            />
          </div>
        </div>
        {legendOpen && <Legend facts={facts} onClose={() => setLegendOpen(false)} />}
      </div>
    </Card>
  )
}
