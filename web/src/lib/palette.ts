// The colour of every category the Cost page draws, as CSS colour strings (`var(--…)` or `color-mix(…)`).
// One place, so a model has one colour on every scope and every page. The Session page keeps its own copies
// (`CLASS_SERIES` in features/spend/model.ts, `TIER_SERIES`); it can import from here later.
//
// A hue is one category of one dimension and the reserved ones are never reused:
//   cache miss  --series-5 (pink)         cold compaction  --bad (red)
//   warm compaction  --warn (amber)       overhead  the hatch (`HATCH`), never a solid colour

import { compareVersions, modelFamily, modelVersion } from './models'
import { TIERS, tierOf } from './tiers'

/** What (overhead) is drawn with: not a colour but the diagonal hatch the callers paint themselves. */
export const HATCH = 'hatch'

export const CACHE_MISS = 'var(--series-5)'
export const COMPACTION_COLD = 'var(--bad)'
export const COMPACTION_WARM = 'var(--warn)'
/** Models Merlin cannot place in a family. */
export const OTHER = 'var(--series-other)'

/**
 * The hue of a family. Claude: Opus blue, Sonnet orange, Haiku teal, Fable violet (the first four series). GPT sizes
 * have tokens of their own (`--model-*` in styles.css, green, gold, steel) because the series hues are taken and the
 * pink is reserved.
 */
const HUE: Record<string, string> = {
  opus: 'var(--series-1)',
  sonnet: 'var(--series-2)',
  haiku: 'var(--series-3)',
  fable: 'var(--series-4)',
  astra: 'var(--model-astra)',
  sol: 'var(--model-sol)',
  luna: 'var(--model-luna)',
}

/** Families in stack order within a tier (and the legend's). */
const FAMILY_ORDER = ['fable', 'opus', 'astra', 'sonnet', 'sol', 'haiku', 'luna']

/**
 * The releases of each family, newest first, as "5.5". A model's lightness step is how many of these are newer than
 * it, so it does not depend on which models the scope happens to show. A version newer than the list is the newest.
 * Add a line when a family ships a version.
 */
const RELEASES: Record<string, string[]> = {
  fable: ['5.2', '5.1', '5'],
  opus: ['5.5', '5', '4.7', '4.6', '4.5', '4.1', '4'],
  sonnet: ['5.5', '5', '4.6', '4.5', '4', '3.7', '3.5'],
  haiku: ['5.5', '4.5', '3.5', '3'],
  astra: ['6.1', '6'],
  sol: ['6.1', '6'],
  luna: ['6.1', '6'],
}

/** The share of the hue per step: the newest version, the next, then the one before that and all older. */
export const VERSION_MIX = [100, 65, 40]

const parseRelease = (s: string) => s.split('.').map(Number)

/** 0 for the newest release of the family, 1 for the next, ... (not capped). */
function versionStep(family: string, version: number[] | undefined): number {
  if (!version) return VERSION_MIX.length - 1
  let newer = 0
  for (const r of RELEASES[family] ?? []) if (compareVersions(parseRelease(r), version) > 0) newer++
  return newer
}

/** The colour of a model, by family and version (never by rank); (overhead) is `HATCH`, an unknown name is grey. */
export function modelColor(key: string): string {
  if (key === '(overhead)') return HATCH
  const family = modelFamily(key)
  const hue = family ? HUE[family] : undefined
  if (!hue || !family) return OTHER
  const mix = VERSION_MIX[Math.min(versionStep(family, modelVersion(key)), VERSION_MIX.length - 1)]
  return mix === 100 ? hue : `color-mix(in srgb, ${hue} ${mix}%, var(--surface))`
}

/**
 * Stack order, heavy to light (bottom first): by tier (`lib/tiers.ts`), then family, then the newest version first,
 * then name. Usable as a sort comparator.
 */
export function compareModels(a: string, b: string): number {
  const ta = TIERS.indexOf(tierOf(a))
  const tb = TIERS.indexOf(tierOf(b))
  if (ta !== tb) return ta - tb
  const fa = FAMILY_ORDER.indexOf(modelFamily(a) ?? '')
  const fb = FAMILY_ORDER.indexOf(modelFamily(b) ?? '')
  if (fa !== fb) return (fa < 0 ? 99 : fa) - (fb < 0 ? 99 : fb)
  return compareVersions(modelVersion(b), modelVersion(a)) || (a < b ? -1 : a > b ? 1 : 0)
}

/** The price classes, as the Session page's `CLASS_SERIES` (its `read` and `write` are `cacheRead`, `cacheWrite`). */
const CLASS: Record<string, string> = {
  output: 'var(--series-4)',
  cacheRead: 'var(--series-3)',
  cacheWrite: 'var(--series-2)',
  input: OTHER,
  cacheMiss: CACHE_MISS,
  // spend no token count explains: a faint grey, lighter than the input's on a light page, darker on a dark one
  '(unsplit)': 'color-mix(in srgb, var(--series-other) 40%, var(--surface))',
}
CLASS.read = CLASS.cacheRead
CLASS.write = CLASS.cacheWrite
CLASS.reread = CACHE_MISS

export function classColor(key: string): string {
  return CLASS[key] ?? OTHER
}
