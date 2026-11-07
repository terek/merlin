// The drawn key of the spend graph: a small sample of every mark the plot uses, with a few words.
// The samples are drawn with the plot's own constants and colours (exported by TimeView.tsx), so
// that a change to the plot's look changes its key; marks the tree cannot have are left out.
import { type ReactNode, useId } from 'react'
import { TIER_SERIES } from './model'
import {
  BranchNode,
  CHIP,
  COLOR,
  COMPACT_MARK,
  CTX_FILL,
  CTX_LINE,
  DOT_R,
  ELBOW_R,
  elbowPath,
  FRAME_OPACITY,
  HELD_LINE,
  HELD_TINT,
  InheritPattern,
  MISS_COLOR,
  MISS_SIZE,
  markColor,
  OverheadPattern,
  REPORT_DASH,
  SPINE_OPACITY,
  SPINE_W,
  WORKFLOW_DASH,
} from './TimeView'
import { findSwarms, TIER_WEIGHT, type Timeline } from './timeline'
import type { Tree } from './tree'

const W = 28
const H = 16
/** The baseline of a sample. */
const B = 12

/** What the key is told about the tree, to list only the marks it can have. */
export interface KeyFacts {
  agents: boolean
  forks: boolean
  workflows: boolean
  swarms: boolean
  reports: boolean
  sessions: boolean
  misses: boolean
  compactions: { cold: boolean; warm: boolean; unknown: boolean }
  queued: boolean
  overhead: boolean
}

export function keyFacts(tree: Tree, timeline: Timeline): KeyFacts {
  const lanes = timeline.lanes.filter((l) => !l.main)
  const cs = tree.branches.flatMap((b) => [...b.model.compactions, ...b.model.agentCompactions])
  return {
    agents: lanes.length > 0,
    forks: lanes.some((l) => l.kind === 'fork'),
    workflows: lanes.some((l) => l.agent?.kind === 'workflow'),
    swarms: findSwarms(timeline.lanes).length > 0,
    reports: lanes.some((l) => l.units.some((u) => u.reports.length > 0)),
    sessions: tree.branches.length > 1,
    misses: tree.rereads.length > 0,
    compactions: {
      cold: cs.some((c) => c.call?.cache === 'cold'),
      warm: cs.some((c) => c.call && c.call.cache !== 'cold'),
      unknown: cs.some((c) => !c.call),
    },
    queued: tree.branches.some((b) => b.model.cols.some((c) => (c.turn.queued?.length ?? 0) > 0)),
    overhead: tree.overheadUSD >= 0.005,
  }
}

function Entry({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <li className="flex items-center gap-1.5" title={title}>
      <svg width={W} height={H} className="shrink-0" role="img" aria-label={label}>
        {children}
      </svg>
      <span>{label}</span>
    </li>
  )
}

const main = COLOR.main
/** A context of some height, as the plot's area and outline. */
const ctxArea = (x0: number, x1: number, y: number, color = main) => (
  <>
    <path d={`M${x0} ${B}V${y}H${x1}V${B}Z`} fill={color} fillOpacity={CTX_FILL} />
    <path d={`M${x0} ${y}H${x1}`} stroke={color} strokeWidth={CTX_LINE} fill="none" />
  </>
)
const base = (color = 'var(--faint)') => (
  <line x1={0} x2={W} y1={B + 0.5} y2={B + 0.5} stroke={color} strokeWidth={0.75} />
)

export function Key({ facts, className }: { facts: KeyFacts; className?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9-]/g, '')
  const f = facts
  const held = (strong: boolean) => {
    const l = strong ? HELD_LINE.strong : HELD_LINE.faint
    return (
      <>
        {ctxArea(0, 8, 5)}
        <rect x={8} y={5} width={W - 8} height={B - 5} fill={main} fillOpacity={HELD_TINT} />
        <line
          x1={8}
          x2={W - 1}
          y1={5}
          y2={5}
          stroke={main}
          strokeOpacity={l.opacity}
          strokeWidth={l.width}
          strokeDasharray={l.dash}
          strokeLinecap="round"
        />
        {base()}
      </>
    )
  }
  const compaction = (cache: 'cold' | 'warm' | 'unknown') => {
    const m = cache === 'cold' ? COMPACT_MARK.cold : COMPACT_MARK.warm
    return (
      <>
        {ctxArea(0, 14, 4)}
        <line
          x1={14}
          x2={14}
          y1={1}
          y2={B}
          stroke={markColor(cache === 'unknown' ? undefined : { cache })}
          strokeWidth={m.width}
          strokeDasharray={m.dash}
        />
        {ctxArea(14, W, 9)}
        {base()}
      </>
    )
  }
  const frame = (kind: 'sub' | 'fork' | 'workflow') => {
    const color = kind === 'fork' ? COLOR.fork : kind === 'workflow' ? COLOR.addressable : COLOR.subagent
    return (
      <>
        <path
          d={`M2 ${B}V3H${W - 2}V7`}
          fill="none"
          stroke={color}
          strokeOpacity={FRAME_OPACITY}
          strokeDasharray={kind === 'workflow' ? WORKFLOW_DASH : undefined}
        />
        {kind === 'fork' && <path d="M2 3h7l-7 7z" fill={color} />}
        <line x1={0} x2={W} y1={B + 0.5} y2={B + 0.5} stroke="var(--line)" />
      </>
    )
  }
  return (
    <ul
      className={`flex flex-wrap gap-x-4 gap-y-1.5 text-meta text-muted ${className ?? ''}`}
      aria-label="How the marks of the graph look"
    >
      <Entry
        label="context of a call (running)"
        title="The context each call was sent with, on one scale for every row"
      >
        {ctxArea(0, 10, 7)}
        {ctxArea(10, 20, 3)}
        {ctxArea(20, W, 6)}
        {base()}
      </Entry>
      <Entry label="held, a turn or agent working" title="Context kept over a pause, while the work still ran">
        {held(true)}
      </Entry>
      <Entry label="held, waiting for a message" title="Context kept over a pause, between turns or pieces of work">
        {held(false)}
      </Entry>
      {f.misses && (
        <Entry label="cache miss" title="Context that had been cached and was billed again in full">
          <rect
            x={W / 2 - MISS_SIZE / 2}
            y={6 - MISS_SIZE / 2}
            width={MISS_SIZE}
            height={MISS_SIZE}
            transform={`rotate(45 ${W / 2} 6)`}
            fill={MISS_COLOR}
            stroke="var(--surface)"
            strokeWidth={1.5}
          />
          {base()}
        </Entry>
      )}
      {f.compactions.cold && <Entry label="compaction, cold cache">{compaction('cold')}</Entry>}
      {f.compactions.warm && <Entry label="compaction, warm cache">{compaction('warm')}</Entry>}
      {f.compactions.unknown && <Entry label="compaction, call unknown">{compaction('unknown')}</Entry>}
      <Entry label="your prompt" title="A message you sent; the bracket over it totals everything up to your next one">
        {base()}
        <circle cx={W / 2} cy={B} r={DOT_R} fill="var(--text)" stroke="var(--surface)" />
      </Entry>
      {f.queued && (
        <Entry label="typed while a turn ran" title="Hollow: it started no turn, but steered the running one">
          {base()}
          <circle cx={W / 2} cy={B} r={DOT_R} fill="var(--surface)" stroke="var(--text)" strokeWidth={1.25} />
        </Entry>
      )}
      <Entry label="decision" title="The total of everything between a prompt of yours and your next one">
        <path d={`M3 ${B}V4H${W - 3}V7`} fill="none" stroke="var(--faint)" />
        {base()}
      </Entry>
      <Entry label="pinned decision">
        <path d={`M3 ${B}V4H${W - 3}V7`} fill="none" stroke="var(--accent)" strokeWidth={3} />
        {base()}
      </Entry>
      <Entry
        label="turn: heavy, mid, light model"
        title="A turn is a stretch of the baseline as heavy as its model's price tier"
      >
        {(['heavy', 'mid', 'light'] as const).map((t, i) => (
          <line
            key={t}
            x1={1 + i * 9}
            x2={7 + i * 9}
            y1={B + 0.5}
            y2={B + 0.5}
            stroke="var(--text)"
            strokeWidth={TIER_WEIGHT[t]}
          />
        ))}
        {[0, 7, 9, 16, 18, 25].map((x) => (
          <line key={x} x1={x + 0.5} x2={x + 0.5} y1={B - 4} y2={B + 5} stroke="var(--text)" />
        ))}
      </Entry>
      <Entry label="idle between turns" title="The main agent waited">
        <line x1={1} x2={7} y1={B + 0.5} y2={B + 0.5} stroke="var(--text)" strokeWidth={TIER_WEIGHT.mid} />
        {base()}
        <line x1={8} x2={8} y1={B - 4} y2={B + 5} stroke="var(--text)" />
        <line x1={20} x2={20} y1={B - 4} y2={B + 5} stroke="var(--text)" />
        <line x1={21} x2={W - 1} y1={B + 0.5} y2={B + 0.5} stroke="var(--text)" strokeWidth={TIER_WEIGHT.mid} />
      </Entry>
      <Entry label="spend per slot (under the baseline)">
        {base()}
        {TIER_SERIES.slice(0, 3).map((s, i) => (
          <rect key={s.key} x={4 + i * 8} y={B + 1} width={6} height={3 - i * 0.5} fill={s.color} />
        ))}
      </Entry>
      {f.agents && (
        <Entry label="agent spine" title="Leads from the row that launched an agent, along the agent's baseline">
          <path
            d={elbowPath(4, 1, B)}
            fill="none"
            stroke={COLOR.subagent}
            strokeWidth={SPINE_W}
            strokeLinecap="round"
            opacity={Math.max(SPINE_OPACITY, 0.7)}
          />
          <line
            x1={4 + ELBOW_R}
            x2={W - 1}
            y1={B}
            y2={B}
            stroke={COLOR.subagent}
            strokeWidth={TIER_WEIGHT.mid}
            opacity={Math.max(SPINE_OPACITY, 0.7)}
          />
        </Entry>
      )}
      {f.forks && (
        <Entry label="fork, with the context it copied" title="A fork leaves from the top of its parent's context">
          <defs>
            <InheritPattern id={`${id}-inh`} color={main} />
          </defs>
          {ctxArea(0, 7, 3)}
          <rect x={7} y={5} width={W - 7} height={B - 5} fill={`url(#${id}-inh)`} />
          <path d={elbowPath(7, 3, B)} fill="none" stroke={COLOR.fork} strokeWidth={SPINE_W} strokeLinecap="round" />
          <line x1={7 + ELBOW_R} x2={W - 1} y1={B} y2={B} stroke={COLOR.fork} strokeWidth={TIER_WEIGHT.mid} />
          <BranchNode x={7} y={3} color={COLOR.fork} />
        </Entry>
      )}
      {f.agents && <Entry label="agent's work (frame)">{frame('sub')}</Entry>}
      {f.forks && <Entry label="fork (notch)">{frame('fork')}</Entry>}
      {f.workflows && <Entry label="workflow (dashed)">{frame('workflow')}</Entry>}
      {f.swarms && (
        <Entry label="swarm: click to open" title="Four or more agents launched together are one row">
          <rect
            x={W / 2 - CHIP / 2}
            y={2}
            width={CHIP}
            height={CHIP}
            rx={3}
            fill="var(--surface)"
            stroke={COLOR.subagent}
            strokeOpacity={0.7}
          />
          <path
            d={`M${W / 2 - CHIP / 2 + 3} ${2 + CHIP / 2}h${CHIP - 6}M${W / 2} 5v${CHIP - 6}`}
            stroke={COLOR.subagent}
            strokeWidth={1.25}
            fill="none"
          />
        </Entry>
      )}
      {f.reports && (
        <Entry label="report" title="A dashed line goes to each turn an agent's report came in">
          <line x1={W / 2} x2={W / 2} y1={1} y2={B - 1} stroke={COLOR.subagent} strokeDasharray={REPORT_DASH} />
          <path d={`M${W / 2 - 3} ${B} L${W / 2} ${B - 4.5} L${W / 2 + 3} ${B}Z`} fill={COLOR.subagent} />
          {base()}
        </Entry>
      )}
      {f.sessions && (
        <Entry
          label="forked or continued session"
          title="A session's spine bends down from its parent's row, as heavy as its model; a dot where a fork left, a ring for a continuation"
        >
          <path
            d={elbowPath(5, 3, B)}
            fill="none"
            stroke={COLOR.main}
            strokeWidth={TIER_WEIGHT.mid}
            strokeLinecap="round"
          />
          <line x1={5 + ELBOW_R} x2={W - 1} y1={B} y2={B} stroke={COLOR.main} strokeWidth={TIER_WEIGHT.mid} />
          <BranchNode x={5} y={3} color={COLOR.main} />
        </Entry>
      )}
      <Entry label="break" title="Time in which nothing ran, left out">
        <rect x={5} y={1} width={W - 10} height={H - 2} fill="var(--surface-2)" opacity={0.8} />
        <path d="M5 4l3 -3M17 4l3 -3" stroke="var(--faint)" />
      </Entry>
      {f.overhead && (
        <Entry
          label="not explained by messages"
          title="A stretch the harness reported a cost for beyond its messages; on no scale"
        >
          <defs>
            <OverheadPattern id={`${id}-ovh`} />
          </defs>
          <rect
            x={1}
            y={1}
            width={W - 2}
            height={H - 2}
            rx={2}
            fill={`url(#${id}-ovh)`}
            stroke="var(--muted)"
            strokeOpacity={0.4}
          />
        </Entry>
      )}
    </ul>
  )
}
