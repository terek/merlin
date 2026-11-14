// Model names.

const FAMILIES = new Set(['fable', 'opus', 'sonnet', 'haiku'])

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const NEW_STYLE = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]*\])?$/
const OLD_STYLE = /^claude-(\d+)(?:-(\d{1,2}))?-(fable|opus|sonnet|haiku)(?:-\d{8})?(?:\[[^\]]*\])?$/

const GPT = /^gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?$/

/**
 * "claude-fable-5-1" -> "Fable 5.1", "gpt-6.1-sol" -> "GPT-6.1 Sol", "claude-haiku-4-5-20251001" -> "Haiku 4.5",
 * "claude-3-5-sonnet-20241022" -> "Sonnet 3.5", a bare family alias ("haiku") -> "Haiku".
 * Anything else, "(overhead)" included, is returned unchanged.
 */
export function modelLabel(name: string): string {
  const n = NEW_STYLE.exec(name)
  if (n) return `${cap(n[1])} ${n[2]}${n[3] ? `.${n[3]}` : ''}`
  const o = OLD_STYLE.exec(name)
  if (o) return `${cap(o[3])} ${o[1]}${o[2] ? `.${o[2]}` : ''}`
  if (FAMILIES.has(name)) return cap(name)
  const g = GPT.exec(name)
  if (g) return `GPT-${g[1]}${g[2] ? ` ${cap(g[2])}` : ''}`
  return name
}

const GPT_FAMILY = /^gpt-\d+(?:\.\d+)?-(astra|sol|luna)(?:-|$)/

/**
 * The family a model name belongs to, by name alone: "fable", "opus", "sonnet", "haiku" (any of the
 * spellings `modelLabel` reads, dated ids and `[1m]` included) or a GPT size, "astra", "sol", "luna".
 * undefined for anything else.
 */
export function modelFamily(name: string): string | undefined {
  const n = NEW_STYLE.exec(name) ?? OLD_STYLE.exec(name)
  if (n) return n[1] && FAMILIES.has(n[1]) ? n[1] : n[3]
  if (FAMILIES.has(name)) return name
  return GPT_FAMILY.exec(name.replace(/\[[^\]]*\]$/, ''))?.[1]
}

const GPT_VERSION = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/

/**
 * The version of a model by name, as numbers to compare: "claude-opus-5-5" -> [5, 5], "claude-sonnet-4-20250514" ->
 * [4], "gpt-6.1-sol" -> [6, 1]. undefined for a bare alias or anything else.
 */
export function modelVersion(name: string): number[] | undefined {
  const bare = name.replace(/\[[^\]]*\]$/, '')
  const n = NEW_STYLE.exec(bare)
  if (n) return n[3] ? [Number(n[2]), Number(n[3])] : [Number(n[2])]
  const o = OLD_STYLE.exec(bare)
  if (o) return o[2] ? [Number(o[1]), Number(o[2])] : [Number(o[1])]
  const g = GPT_VERSION.exec(bare)
  return g ? (g[2] ? [Number(g[1]), Number(g[2])] : [Number(g[1])]) : undefined
}

/** Compares two versions from `modelVersion`: negative when `a` is older, 0 when equal; a missing one is oldest. */
export function compareVersions(a: number[] | undefined, b: number[] | undefined): number {
  const x = a ?? []
  const y = b ?? []
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return (a ? 1 : 0) - (b ? 1 : 0)
}
