// The legend of the spend graph: a panel floating over the plot's top-right corner (as a map's legend
// does), a small sample of every mark the plot uses with a few words, in groups by meaning. The
// samples are drawn with the plot's own constants and colours (exported by TimeView.tsx), so that a
// change to the plot's look changes its legend; marks the tree cannot have are listed too, faint.
import { type ReactNode, useId, useState } from 'react'
import { AXIS_H } from './layout'
import {
  BREAK_VEIL,
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
  SPEND_COLOR,
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

/** One row of a group's grid: the sample, then its words. An absent mark is faint, and says why. */
function Entry({
  label,
  title,
  absent,
  children,
}: {
  label: string
  title?: string
  absent?: boolean
  children: ReactNode
}) {
  const faint = absent ? 'opacity-40' : undefined
  const tip = absent ? 'not in this session' : title
  return (
    <li className="contents">
      <svg width={W} height={H} className={`shrink-0 ${faint ?? ''}`} role="img" aria-label={label}>
        <title>{tip}</title>
        {children}
      </svg>
      <span className={faint} title={tip}>
        {label}
      </span>
    </li>
  )
}

/** Where the legend starts, from the top of the TimePlot block: under its readout (4.75rem, 0.25rem gap)
 * and the clock ticks (AXIS_H), so that it hides none of them. */
const LEGEND_TOP = `calc(5rem + ${AXIS_H + 6}px)`
const OPEN_KEY = 'merlin.spend.legend'
/** Whether the viewer left the legend open; closed by default, and also when storage is not there. */
const readOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) === 'open'
  } catch {
    return false
  }
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
  const [open, setOpen] = useState(readOpen)
  const set = (o: boolean) => {
    setOpen(o)
    try {
      localStorage.setItem(OPEN_KEY, o ? 'open' : 'closed')
    } catch {}
  }
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
  // Every entry the graph can show, in groups by what the mark means. `has` is false for a mark this
  // session does not have: it is still listed, faint.
  const groups: { title: string; entries: { label: string; title?: string; has: boolean; sample: ReactNode }[] }[] = [
    {
      title: 'Sessions and agents',
      entries: [
        {
          label: 'session line: heavy, mid, light model',
          title: "The session's line runs unbroken, idle or not, as heavy as its model's price tier",
          has: true,
          sample: (
            <>
              {base()}
              {(['heavy', 'mid', 'light'] as const).map((t, i) => (
                <line
                  key={t}
                  x1={i * 9.33}
                  x2={(i + 1) * 9.33}
                  y1={B + 0.5}
                  y2={B + 0.5}
                  stroke={main}
                  strokeWidth={TIER_WEIGHT[t]}
                />
              ))}
              {[3, 12, 21].map((x) => (
                <line key={x} x1={x + 0.5} x2={x + 0.5} y1={B - 4} y2={B + 5} stroke="var(--text)" />
              ))}
            </>
          ),
        },
        {
          label: 'forked or continued session',
          title:
            "A session's line bends down from its parent's baseline, as heavy as the line it left; a dot where a fork left, a ring for a continuation",
          has: f.sessions,
          sample: (
            <>
              <line x1={0} x2={5} y1={3} y2={3} stroke={COLOR.main} strokeWidth={TIER_WEIGHT.mid} />
              <path
                d={elbowPath(5, 3, B)}
                fill="none"
                stroke={COLOR.main}
                strokeWidth={TIER_WEIGHT.mid}
                strokeLinecap="round"
              />
              <line x1={5 + ELBOW_R} x2={W - 1} y1={B} y2={B} stroke={COLOR.main} strokeWidth={TIER_WEIGHT.mid} />
              <BranchNode x={5} y={3} color={COLOR.main} />
            </>
          ),
        },
        {
          label: 'agent spine',
          title: "Leads from the row that launched an agent, along the agent's baseline",
          has: f.agents,
          sample: (
            <>
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
            </>
          ),
        },
        {
          label: 'fork, with the context it copied',
          title: "A fork takes the whole context: it leaves from its sender's line, as heavy as the agent",
          has: f.forks,
          sample: (
            <>
              <defs>
                <InheritPattern id={`${id}-inh`} color={main} />
              </defs>
              {ctxArea(0, 7, 3)}
              <rect x={7} y={5} width={W - 7} height={B - 5} fill={`url(#${id}-inh)`} />
              <line x1={0} x2={7} y1={3} y2={3} stroke={main} strokeWidth={TIER_WEIGHT.mid} />
              <path
                d={elbowPath(7, 3, B)}
                fill="none"
                stroke={COLOR.fork}
                strokeWidth={TIER_WEIGHT.mid}
                strokeLinecap="round"
              />
              <line x1={7 + ELBOW_R} x2={W - 1} y1={B} y2={B} stroke={COLOR.fork} strokeWidth={TIER_WEIGHT.mid} />
              <BranchNode x={7} y={3} color={COLOR.fork} />
            </>
          ),
        },
        { label: "agent's work (frame)", has: f.agents, sample: frame('sub') },
        { label: 'fork (notch)', has: f.forks, sample: frame('fork') },
        { label: 'workflow (dashed)', has: f.workflows, sample: frame('workflow') },
        {
          label: 'swarm: click to open',
          title: 'Four or more agents launched together are one row',
          has: f.swarms,
          sample: (
            <>
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
            </>
          ),
        },
        {
          label: 'report',
          title: "A dashed line goes to each turn an agent's report came in",
          has: f.reports,
          sample: (
            <>
              <line x1={W / 2} x2={W / 2} y1={1} y2={B - 1} stroke={COLOR.subagent} strokeDasharray={REPORT_DASH} />
              <path d={`M${W / 2 - 3} ${B} L${W / 2} ${B - 4.5} L${W / 2 + 3} ${B}Z`} fill={COLOR.subagent} />
              {base()}
            </>
          ),
        },
      ],
    },
    {
      title: 'Context',
      entries: [
        {
          label: 'context of a call (running)',
          title: 'The context each call was sent with, on one scale for every row',
          has: true,
          sample: (
            <>
              {ctxArea(0, 10, 7)}
              {ctxArea(10, 20, 3)}
              {ctxArea(20, W, 6)}
              {base()}
            </>
          ),
        },
        {
          label: 'held, a turn or agent working',
          title: 'Context kept over a pause, while the work still ran',
          has: true,
          sample: held(true),
        },
        {
          label: 'held, waiting for a message',
          title: 'Context kept over a pause, between turns or pieces of work',
          has: true,
          sample: held(false),
        },
        {
          label: 'cache miss',
          title: 'Context that had been cached and was billed again in full',
          has: f.misses,
          sample: (
            <>
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
            </>
          ),
        },
        { label: 'compaction, cold cache', has: f.compactions.cold, sample: compaction('cold') },
        { label: 'compaction, warm cache', has: f.compactions.warm, sample: compaction('warm') },
        { label: 'compaction, call unknown', has: f.compactions.unknown, sample: compaction('unknown') },
      ],
    },
    {
      title: 'Your turns',
      entries: [
        {
          label: 'your prompt',
          title: 'A message you sent; the bracket over it totals everything up to your next one',
          has: true,
          sample: (
            <>
              {base()}
              <circle cx={W / 2} cy={B} r={DOT_R} fill="var(--text)" stroke="var(--surface)" />
            </>
          ),
        },
        {
          label: 'typed while a turn ran',
          title: 'Hollow: it started no turn, but steered the running one',
          has: f.queued,
          sample: (
            <>
              {base()}
              <circle cx={W / 2} cy={B} r={DOT_R} fill="var(--surface)" stroke="var(--text)" strokeWidth={1.25} />
            </>
          ),
        },
        {
          label: 'decision',
          title: 'The total of everything between a prompt of yours and your next one',
          has: true,
          sample: (
            <>
              <path d={`M3 ${B}V4H${W - 3}V7`} fill="none" stroke="var(--faint)" />
              {base()}
            </>
          ),
        },
        {
          label: 'pinned decision',
          has: true,
          sample: (
            <>
              <path d={`M3 ${B}V4H${W - 3}V7`} fill="none" stroke="var(--accent)" strokeWidth={3} />
              {base()}
            </>
          ),
        },
      ],
    },
    {
      title: 'Spend',
      entries: [
        {
          label: 'spend per slot (under the baseline)',
          has: true,
          sample: (
            <>
              {base()}
              {[4, 8, 12, 16, 20].map((x, i) => (
                <line
                  key={x}
                  x1={x + 0.5}
                  x2={x + 0.5}
                  y1={B + 1}
                  y2={B + 1 + [3, 4, 2, 4, 3][i]}
                  stroke={SPEND_COLOR}
                />
              ))}
              <line x1={12.5} x2={12.5} y1={B + 3} y2={B + 6} stroke={MISS_COLOR} strokeWidth={1.5} />
            </>
          ),
        },
        {
          label: 'not explained by messages',
          title: 'A stretch the harness reported a cost for beyond its messages; on no scale',
          has: f.overhead,
          sample: (
            <>
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
            </>
          ),
        },
      ],
    },
    {
      title: 'Time',
      entries: [
        {
          label: 'break',
          title: 'Time in which nothing ran, left out',
          has: true,
          sample: (
            <>
              {/* a gridline and a baseline crossing the break, faded by its veil */}
              <line x1={0} x2={W} y1={5.5} y2={5.5} stroke="var(--border)" />
              <line x1={0} x2={W} y1={B + 0.5} y2={B + 0.5} stroke="var(--faint)" />
              <rect x={8} y={1} width={W - 16} height={H - 2} fill="var(--surface)" opacity={BREAK_VEIL} />
              <path d="M8 4l3 -3M17 4l3 -3" stroke="var(--faint)" />
            </>
          ),
        },
      ],
    },
  ]
  return (
    <div
      className={`pointer-events-none absolute right-2 bottom-2 z-10 flex flex-col items-end ${className ?? ''}`}
      style={{ top: LEGEND_TOP }}
    >
      {open ? (
        <section
          className="pointer-events-auto flex max-h-full min-h-0 w-64 flex-col overflow-y-auto rounded-badge border border-line bg-surface text-meta text-muted shadow-lg"
          aria-label="Legend: how the marks of the graph look"
        >
          <header className="sticky top-0 flex items-center justify-between bg-surface px-2.5 py-1.5">
            <h3 className="font-medium text-sec">Legend</h3>
            <button
              type="button"
              onClick={() => set(false)}
              aria-label="Close the legend"
              className="rounded px-1.5 text-sec hover:text-text focus-visible:outline-2"
            >
              ×
            </button>
          </header>
          <div className="flex flex-col gap-2.5 px-2.5 pb-2.5">
            {groups.map((g) => (
              <section key={g.title}>
                <h4 className="mb-1 text-[0.6875rem] font-medium uppercase tracking-wide text-faint">{g.title}</h4>
                <ul className="grid grid-cols-[28px_1fr] items-center gap-x-2 gap-y-1.5">
                  {g.entries.map((e) => (
                    <Entry key={e.label} label={e.label} title={e.title} absent={!e.has}>
                      {e.sample}
                    </Entry>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </section>
      ) : (
        <button
          type="button"
          onClick={() => set(true)}
          className="pointer-events-auto rounded-badge border border-line bg-surface px-2 py-1 text-meta text-sec shadow-md hover:text-text"
        >
          Legend
        </button>
      )}
    </div>
  )
}
