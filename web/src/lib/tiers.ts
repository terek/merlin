// Model tiers: what a model costs, sorted into heavy, mid and light, so that the spend graph can show which
// class of model ran where. A good setup runs the main agent on a heavy model and the workers on cheaper ones.

import type { PriceEntry, PriceList } from '../api/types'
import { modelFamily } from './models'

export type Tier = 'heavy' | 'mid' | 'light' | 'unknown'

/** Tiers from the most to the least expensive, then the unpriced. */
export const TIERS: readonly Tier[] = ['heavy', 'mid', 'light', 'unknown']

/** A model whose input costs at least this much per million tokens is heavy. */
export const HEAVY_FROM = 4
/** ... and one whose input costs at most this much is light. */
export const LIGHT_UPTO = 1

/** The table's models by name (`PriceList.models`). */
export type Prices = PriceList['models']

const FAMILY_TIER: Record<string, Tier> = {
  fable: 'heavy',
  opus: 'heavy',
  sonnet: 'mid',
  haiku: 'light',
  astra: 'heavy',
  sol: 'mid',
  luna: 'light',
}

const DATE = /-\d{8}$/
const strip1m = (s: string) => s.replace(/\[1m\]$/, '').trim()

interface Index {
  named: Map<string, string>
  dated: Map<string, string>
}
const indexes = new WeakMap<object, Index>()

function indexOf(prices: Prices): Index {
  let ix = indexes.get(prices)
  if (!ix) {
    ix = { named: new Map(), dated: new Map() }
    for (const [name, p] of Object.entries(prices)) {
      for (const a of p.aliases ?? []) ix.named.set(strip1m(a), name)
      if (DATE.test(name)) ix.dated.set(name.replace(DATE, ''), name)
    }
    indexes.set(prices, ix)
  }
  return ix
}

/**
 * The entry of a model, found as the daemon finds it: without `[1m]`, by exact name, without a trailing
 * date, by a declared alias, then an entry stored with a date.
 */
export function priceOf(model: string, prices: Prices | undefined): PriceEntry | undefined {
  if (!prices) return undefined
  const n = strip1m(model)
  const hit = (name: string | undefined) => (name ? prices[name] : undefined)
  const ix = indexOf(prices)
  const undated = n.replace(DATE, '')
  return hit(n) ?? (undated !== n ? hit(undated) : undefined) ?? hit(ix.named.get(n)) ?? hit(ix.dated.get(n))
}

/** The tier of an input price in dollars per million tokens. */
export function tierOfInput(input: number): Tier {
  return input >= HEAVY_FROM ? 'heavy' : input <= LIGHT_UPTO ? 'light' : 'mid'
}

/**
 * The tier of a model by its input price. A model the table does not price (or no table yet) falls back to
 * its family, by name: Fable and Opus heavy, Sonnet mid, Haiku light, GPT astra heavy, sol mid, luna light.
 * unknown when neither knows it.
 */
export function tierOf(model: string, prices?: Prices): Tier {
  const p = priceOf(model, prices)
  if (p) return tierOfInput(p.input)
  const f = modelFamily(strip1m(model))
  return (f && FAMILY_TIER[f]) || 'unknown'
}
