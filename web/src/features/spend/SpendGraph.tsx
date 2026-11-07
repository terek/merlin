// The spend graph: the card around the time view (TimeView.tsx), with the legend, the compactions,
// the readout of what is under the cursor and the key handling. The pinned turn and the selected
// piece of agent work are the page's; the panels under the card open them.
import { type KeyboardEvent, useMemo, useState } from 'react'
import { usePrices } from '../../api/queries'
import { approx, callLine, tallyLine, warmLine } from '../../lib/compaction'
import { spendBasis } from '../../lib/cost'
import { formatCount, formatDuration, formatMoney, formatPercent, formatTokens, plural } from '../../lib/format'
import { modelLabel } from '../../lib/models'
import { firstLine } from '../../lib/paths'
import { unwrapMachineText } from '../../lib/wrapper'
import { Card, ModelName, SegmentedControl } from '../../ui'
import { KindIcon } from '../agents/AgentRow'
import { agentLabel } from '../agents/model'
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
} from './model'
import { Overview } from './Overview'
import { TimePlot } from './TimeView'
import {
  activeMs,
  boundsOf,
  buildTimeline,
  clampWindow,
  defaultWindow,
  revealWindow,
  splitDays,
  tierSpend,
  type Win,
} from './timeline'
import type { Branch, Tree } from './tree'

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
}

/** A tree with more activity than this gets the overview even when it ran on one day. */
const OVERVIEW_MIN_MS = 3 * 60 * 60_000

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
        Hover, or press ← →, to read a turn; hover a piece of agent work to read what an agent was given. Click pins it
        and opens it below.
      </div>
    )
  }
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
    <div className="min-h-[4.5rem] space-y-0.5 text-sec" aria-live="polite">
      <div className="flex items-baseline gap-x-3 overflow-hidden whitespace-nowrap">
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
          <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
            <KindIcon agent={u.agent} color={kindColor(u.agent)} />
            <span className="font-medium">{agentLabel(u.agent)}</span>
            {u.of > 1 && (
              <span className="text-muted">
                {u.ordinal} of {u.of}
              </span>
            )}
            <span className="font-mono font-semibold">
              {u.bucket.unpriced > 0 ? '≥' : u.bucket.estimated > 0 ? '~' : ''}
              {formatMoney(u.bucket.usd)}
            </span>
            {u.agent.model && <ModelName name={u.agent.model} className="text-meta text-faint" />}
            <span className="text-muted">
              launched in turn {u.launch}
              {u.returned
                ? `, ${u.reports.length > 1 ? 'reports' : 'report'} in ${turnList(u.reports)}`
                : ', no report'}
              {u.nested.length > 0 &&
                `, ${plural(u.nested.length, 'sub-agent')} of its own (${formatMoney(u.nestedUSD)})`}
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
  const grand = tree.total + (overhead ? tree.overheadUSD : 0)
  const compactions = useMemo(
    () => ({
      ...compactionTally(branches.flatMap((b) => [...b.model.compactions, ...b.model.agentCompactions])),
      inAgents: branches.reduce((n, b) => n + b.model.agentCompactions.length, 0),
    }),
    [branches],
  )

  // a tree that ran long, or on more than one day, is shown a window at a time, picked in the overview
  const prices = usePrices().data?.models // until it arrives (or if it fails) tiers go by the model's family
  const timeline = useMemo(() => buildTimeline(tree, prices), [tree, prices])
  const byTier = useMemo(() => tierSpend(timeline), [timeline])
  const days = useMemo(() => splitDays(timeline), [timeline])
  const bounds = useMemo(() => boundsOf(timeline), [timeline])
  const overview = days.length > 1 || activeMs(timeline) > OVERVIEW_MIN_MS
  const turnStart = (p: Pin | null | undefined) =>
    (p && timeline.lanes.find((l) => l.main && l.branch === p.branch)?.turns.find((x) => x.col.index === p.col)?.t0) ||
    Number.NaN
  const latest = useMemo(() => defaultWindow(timeline, days), [timeline, days])
  const [win, setWin] = useState<Win>(() => {
    if (initialWindow && (initialWindow.lo !== undefined || initialWindow.hi !== undefined))
      return clampWindow({ lo: initialWindow.lo ?? bounds.t0, hi: initialWindow.hi ?? bounds.t1 }, bounds)
    const at = turnStart(pinned ?? cursor)
    return Number.isFinite(at) ? defaultWindow(timeline, days, at) : latest
  })
  // a turn pinned (in the graph, in a panel, in the list of decisions) or reached with the keys brings
  // itself into view
  const [seen, setSeen] = useState({ pin: pinKey(pinned), cursor: pinKey(cursor) })
  if (seen.pin !== pinKey(pinned) || seen.cursor !== pinKey(cursor)) {
    setSeen({ pin: pinKey(pinned), cursor: pinKey(cursor) })
    const t =
      seen.cursor !== pinKey(cursor) && cursor
        ? turnStart(cursor)
        : seen.pin !== pinKey(pinned)
          ? turnStart(pinned)
          : Number.NaN
    if (overview && Number.isFinite(t)) {
      const next = revealWindow(win, t, days, bounds)
      if (next !== win) setWin(next)
    }
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
    setCursor({ branch: b.index, col: b.own[Math.min(b.own.length - 1, Math.max(0, next))] })
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
      {overview && (
        <Overview
          timeline={timeline}
          days={days}
          split={split}
          win={win}
          onWin={setWin}
          pinnedT={turnStart(pinned)}
          latest={latest}
        />
      )}
      <Readout tree={tree} at={shown} unit={shownUnit} split={split} />
      <TimePlot
        tree={tree}
        timeline={timeline}
        range={overview ? win : undefined}
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
      />
      <p className="mt-2 text-meta text-muted">
        Time runs across, local; a narrow grey band is time in which nothing ran, left out. A session that ran long or
        on more than one day shows a window of it, picked on the strip above the plot (the whole session on one scale,
        the window highlighted): it opens on the last day of work, and its scales are its own. A row is the main agent
        of a session or an agent it launched: above its line, the context each call was sent with (one scale for every
        row, so the tall ones are the expensive ones to carry), dotted where the agent held it over a pause (faint while
        a main agent waited for a message), with the context it carried lightly tinted; below it, what the row spent in
        each slot of time, on one dollar scale. A light frame spans an agent's work. A faint spine leads from the row
        that launched an agent, down with a rounded elbow, then along the agent's baseline for its life (full strength
        for the work in focus; a dashed line goes to each turn its report came in); its weight is the model's price,
        heavy 3.5 px, mid 2 px, light 1 px, and a main row's turns are weighted the same, with the model's name where it
        changes. A fork leaves from the top of its parent's context, and a hatched band in its row is the context it
        copied; a sub-agent starts clean, from the baseline. An addressable agent keeps a row of its own, one-shot
        agents share rows, and four or more launched together are one swarm row (click it, marked +, to open it; − folds
        it). A dot is a message you sent (hollow if typed while a turn ran), and the bracket rising from it totals
        everything up to your next one. A diamond is a cache miss, a red mark a compaction on a cold cache, an amber
        dashed one on a warm cache.
        {overhead &&
          ' A hatched band under a session spans a stretch the harness reported a cost for and carries what it reported beyond the messages of that stretch; it is on no scale.'}{' '}
        {spendBasis(tree.branches.length, unknownSessions, recordedSessions)}
        {tree.fromMessages ? '' : '; this daemon sent no messages, so the token classes and cache misses are missing'}.
        {tree.rereads.length > 0 &&
          ` ${plural(tree.rereads.length, 'cache miss', 'cache misses')} (context that had been cached and was billed again in full): ${missSummary(tree.rereads)}.`}
        {tree.wakeups.count > 0 &&
          ` ${plural(tree.wakeups.count, 'piece')} of agent work nobody asked for: an agent woken by its own background work (an expired watch, say) after it had reported, ${formatMoney(tree.wakeups.usd)}.`}
      </p>
    </Card>
  )
}
