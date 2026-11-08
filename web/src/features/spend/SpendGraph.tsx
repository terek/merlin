// The spend graph: the card around the time view (TimeView.tsx), with the legend, the compactions,
// the readout of what is under the cursor and the key handling. The pinned turn and the selected
// piece of agent work are the page's; the panels under the card open them.
import { type KeyboardEvent, useMemo, useRef, useState } from 'react'
import { usePrices } from '../../api/queries'
import type { SessionKey } from '../../api/types'
import { approx, callLine, tallyLine, warmLine } from '../../lib/compaction'
import { spendBasis } from '../../lib/cost'
import { formatCount, formatDuration, formatMoney, formatPercent, formatTokens, plural } from '../../lib/format'
import { modelLabel } from '../../lib/models'
import { firstLine } from '../../lib/paths'
import { unwrapMachineText } from '../../lib/wrapper'
import { Card, ModelName, SegmentedControl } from '../../ui'
import { KindIcon } from '../agents/AgentRow'
import { agentLabel } from '../agents/model'
import { Key, keyFacts } from './Key'
import { kindColor } from './marks'
import {
  compactionTally,
  missSummary,
  missText,
  type Part,
  type Split,
  stepParts,
  TIER_SERIES,
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
  tierSpend,
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
  initialSplit?: Split
  /** Dev and screenshots: start with the cursor on this turn of the home branch. */
  initialCursor?: number
  /** Dev and screenshots: the window of time to show first (`?from=&to=`). */
  initialWindow?: Partial<Win>
  /** Sessions of the tree whose cost is unknown (work, no billed message). */
  unknownSessions?: number
  /** Sessions of the tree whose dollars the harness recorded per call (flag recorded). */
  recordedSessions?: number
  /** The session the page is about: its main row is marked in the plot. */
  current?: SessionKey
}

const pinKey = (p: Pin | null | undefined) => (p ? `${p.branch}/${p.col}` : '')

function Swatch({ color }: { color: string }) {
  return <span aria-hidden className="inline-block size-2 shrink-0 rounded-[2px]" style={{ background: color }} />
}

/** The overhead bands' hatching, as a legend swatch. */
function HatchSwatch() {
  return (
    <span
      aria-hidden
      className="inline-block size-2.5 shrink-0 rounded-[2px] border border-muted/60"
      style={{ background: 'repeating-linear-gradient(45deg, var(--muted) 0 1px, transparent 1px 3.5px)' }}
    />
  )
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
  split,
}: {
  tree: Tree
  at: Pin | undefined
  unit: { branch: Branch; unit: Unit } | undefined
  split: Split
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
            <Chips parts={unitParts(u, split)} />
            <span className="min-w-0 flex-1 truncate text-muted">
              {firstLine(unwrapMachineText(u.asked).body) || u.agent.description}
            </span>
          </div>
        </>
      ) : (
        <>
          <div className="truncate text-muted">{c.prompt || '(no prompt text)'}</div>
          <div className="flex items-center gap-x-3 overflow-hidden whitespace-nowrap">
            <Chips parts={stepParts(c, split)} />
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
  initialSplit = 'kind',
  initialCursor,
  initialWindow,
  unknownSessions = 0,
  recordedSessions = 0,
  current,
}: SpendGraphProps) {
  const [split, setSplit] = useState<Split>(initialSplit)
  const [cursor, setCursor] = useState<Pin | null>(
    initialCursor !== undefined && tree.branches[home]?.model.cols[initialCursor]
      ? { branch: home, col: initialCursor }
      : null,
  )
  const [hoverUnit, setHoverUnit] = useState<UnitRef | null>(null)

  const { branches } = tree
  const focus = pinned?.branch ?? home
  // the parts add up to the harness's figure: the messages, and what it reported beyond them
  const overhead = tree.overheadUSD >= 0.005
  // agent runs that left no record of their spend (a Pi `--no-session` child): unknown, so in no figure
  const unrecordedRuns = branches.reduce((n, b) => n + (b.detail.digest.cost.unrecordedAgents ?? 0), 0)
  const grand = tree.total + (overhead ? tree.overheadUSD : 0)
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
  const byTier = useMemo(() => tierSpend(timeline), [timeline])
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
            {
              value: 'tier',
              label: 'By model tier',
              title:
                'Heavy, mid and light models, by what their input costs (heavy from $4 per million tokens, light up to $1)',
            },
          ]}
        />
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sec">
        {(split === 'tier'
          ? byTier.map((t) => {
              const def = TIER_SERIES.find((s) => s.key === t.tier) ?? TIER_SERIES[3]
              const names = [...new Set(t.models.map((m) => modelLabel(m.model)))]
              return { key: t.tier, color: def.color, label: def.label, usd: t.usd, names }
            })
          : (split === 'kind' ? tree.byKind : tree.byClass).map((p) => ({ ...p, names: [] as string[] }))
        ).map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1.5">
            <Swatch color={p.color} />
            <span>
              {p.label}
              {p.names.length > 0 && <span className="text-muted"> ({p.names.join(', ')})</span>}
            </span>
            <span className="font-mono">{formatMoney(p.usd)}</span>
            <span className="text-faint">{formatPercent(p.usd, grand)}</span>
          </span>
        ))}
        {unrecordedRuns > 0 && (
          <span
            className="inline-flex items-center gap-1.5 text-muted"
            title="The harness kept no record of these agents' calls, so their spend is unknown, not $0. Every figure here is at least that much; the percentages are of the spend that is known."
          >
            <span aria-hidden className="inline-block h-0 w-2.5 shrink-0 border-t border-dashed border-muted" />
            <span>{plural(unrecordedRuns, 'sub-agent run')} not recorded</span>
          </span>
        )}
        {overhead && (
          <span
            className="inline-flex items-center gap-1.5"
            title="Spend the harness reported that no message in the transcripts explains: calls it does not write down. It belongs to a whole reported stretch, so it is drawn under the rows and is in no turn, agent or decision."
          >
            <HatchSwatch />
            <span>Not explained by messages</span>
            <span className="font-mono">{formatMoney(tree.overheadUSD)}</span>
            <span className="text-faint">{formatPercent(tree.overheadUSD, grand)}</span>
          </span>
        )}
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
          split={split}
          win={win}
          eff={eff}
          onWin={setWin}
          pinnedT={turnStart(pinned)}
          latest={latest}
        />
      </div>
      <TimePlot
        tree={tree}
        timeline={timeline}
        range={eff}
        split={split}
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
        turnLines={shown || shownUnit ? <TurnReadout tree={tree} at={shown} unit={shownUnit} split={split} /> : null}
      />
      <Key facts={facts} className="mt-2" />
      <details className="mt-2 text-meta text-muted">
        <summary className="cursor-pointer select-none text-sec">How to read this graph</summary>
        <p className="mt-1">
          Time runs across, local; a narrow grey band is time in which nothing ran, left out. Every row shares one token
          scale above its baseline (so the tall ones are the expensive ones to carry) and one dollar scale below it. The
          plot shows a window of the session, picked on the strip above it (the whole session on one scale, the window
          highlighted): it opens on all of it, and Latest goes to the last day of work. The rows and the token scale are
          those of the whole session, so the plot keeps its shape as the window moves (it looks sparse where the session
          is quiet); the time axis and the dollar scale are the window's own. A fork leaves from the top of its parent's
          context; a sub-agent starts clean, from the baseline. An addressable agent keeps a row of its own, one-shot
          agents share rows, and four or more launched together are one swarm row (marked +; click it to open it, −
          folds it). A person's turns are weighted by the price of their model, and the model's name is written where it
          changes.
          {overhead &&
            ' A hatched band under a session spans a stretch the harness reported a cost for and carries what it reported beyond the messages of that stretch; it is on no scale.'}{' '}
          {spendBasis(tree.branches.length, unknownSessions, recordedSessions)}
          {tree.fromMessages ? '' : '; this daemon sent no messages, so the token classes and cache misses are missing'}
          .
          {tree.rereads.length > 0 &&
            ` ${plural(tree.rereads.length, 'cache miss', 'cache misses')} (context that had been cached and was billed again in full): ${missSummary(tree.rereads)}.`}
          {tree.wakeups.count > 0 &&
            ` ${plural(tree.wakeups.count, 'piece')} of agent work nobody asked for: an agent woken by its own background work (an expired watch, say) after it had reported, ${formatMoney(tree.wakeups.usd)}.`}
        </p>
      </details>
    </Card>
  )
}
