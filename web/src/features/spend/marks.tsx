// What the graph and the box under it share: the colour of an agent's kind and how strongly the graph tints the
// selected turn and its decision.
import type { Agent } from '../../api/types'
import { agentSeries, KIND_SERIES } from './model'

type KindOf = Pick<Agent, 'kind' | 'inheritsContext' | 'addressable'>

/** How strongly the graph tints a selected turn's decision, and its panel's title bar the same. */
export const DECISION_TINT_OPACITY = 0.06
/** How strongly the graph tints the selected turn, over its decision's tint. */
export const TURN_TINT_OPACITY = 0.16
/** How strongly the graph tints the turn a click would select (the hover preview), lighter than the selected one's. */
export const PREVIEW_TINT_OPACITY = TURN_TINT_OPACITY / 2
/** The colour of an agent's kind, as in the graph and its legend. */
export const kindColor = (a: KindOf) => KIND_SERIES.find((s) => s.key === agentSeries(a))?.color ?? 'var(--series-2)'
