// What the graph and the box under it share: the colour of an agent's kind and how strongly the graph tints the
// pinned turn and its decision.
import type { Agent } from '../../api/types'
import { agentSeries, KIND_SERIES } from './model'

type KindOf = Pick<Agent, 'kind' | 'inheritsContext' | 'addressable'>

/** How strongly the graph tints a pinned turn's decision, and its panel's title bar the same. */
export const DECISION_TINT_OPACITY = 0.06
/** How strongly the graph tints the pinned turn, over its decision's tint. */
export const TURN_TINT_OPACITY = 0.16
/** The colour of an agent's kind, as in the graph and its legend. */
export const kindColor = (a: KindOf) => KIND_SERIES.find((s) => s.key === agentSeries(a))?.color ?? 'var(--series-2)'
