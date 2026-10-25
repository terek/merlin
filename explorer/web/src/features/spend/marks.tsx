// What the panels under the spend graph share with it, so that a panel reads as the mark it opens:
// a decision is the graph's bracket (a thick accent line) and its faint tint, the pinned turn its
// tint and the marker over it, a piece of agent work the box of its agent's kind (dashed for a
// workflow, notched for a fork), in the kind's colour.
import type { CSSProperties } from 'react'
import type { Agent } from '../../api/types'
import { agentSeries, KIND_SERIES } from './model'

type KindOf = Pick<Agent, 'kind' | 'inheritsContext' | 'addressable'>

/** How strongly the graph tints a pinned turn's decision, and its panel's title bar the same. */
export const DECISION_TINT_OPACITY = 0.06
/** The decision's tint as a background (6% of the accent, as DECISION_TINT_OPACITY). */
export const DECISION_TINT = 'bg-[color-mix(in_srgb,var(--accent)_6%,var(--surface))]'
/** How strongly the graph tints the pinned turn, over its decision's tint. */
export const TURN_TINT_OPACITY = 0.16
/**
 * The pinned turn's tint as a background: what the graph shows, the turn's 16% over the decision's
 * 6% (1 - 0.94 × 0.84 ≈ 21%), since the pinned turn always lies inside its decision.
 */
export const TURN_TINT = 'bg-[color-mix(in_srgb,var(--accent)_21%,var(--surface))]'

/** The colour of an agent's kind, as in the graph and its legend. */
export const kindColor = (a: KindOf) => KIND_SERIES.find((s) => s.key === agentSeries(a))?.color ?? 'var(--series-2)'

/**
 * A piece of agent work's box, as the graph draws it: tinted and outlined in its kind's colour. An
 * outline, so that it takes no room (a row of a list keeps its size when it is selected).
 */
export function unitBox(a: KindOf): CSSProperties {
  const c = kindColor(a)
  return {
    background: `color-mix(in srgb, ${c} 12%, var(--surface))`,
    outline: `1.5px ${a.kind === 'workflow' ? 'dashed' : 'solid'} ${c}`,
    outlineOffset: -1.5,
  }
}

/** A fork's notch, in the top left corner of its box; the box is `relative`. */
export function Notch({ agent }: { agent: KindOf }) {
  if (agentSeries(agent) !== 'fork') return null
  return (
    <svg width={7} height={7} className="pointer-events-none absolute top-0 left-0">
      <title>fork</title>
      <path d="M0 0h7L0 7z" fill={kindColor(agent)} />
    </svg>
  )
}

/** The bracket the graph draws over a decision's turns, small. */
export function BracketMark() {
  return (
    <svg width={18} height={9} className="shrink-0">
      <title>the bracket over these turns in the graph</title>
      <path d="M1.5 9V1.5H16.5V9" fill="none" stroke="var(--accent)" strokeWidth={3} />
    </svg>
  )
}

/** The marker the graph puts over the pinned turn. */
export function PinMark() {
  return (
    <svg width={10} height={8} className="shrink-0">
      <title>the pinned turn in the graph</title>
      <path d="M1 1h8l-4 6z" fill="var(--accent)" />
    </svg>
  )
}
