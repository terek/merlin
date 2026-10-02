// Model names.

const FAMILIES = new Set(['fable', 'opus', 'sonnet', 'haiku'])

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const NEW_STYLE = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]*\])?$/
const OLD_STYLE = /^claude-(\d+)(?:-(\d{1,2}))?-(fable|opus|sonnet|haiku)(?:-\d{8})?(?:\[[^\]]*\])?$/

/**
 * "claude-fable-5-1" -> "Fable 5.1", "claude-haiku-4-5-20251001" -> "Haiku 4.5",
 * "claude-3-5-sonnet-20241022" -> "Sonnet 3.5", a bare family alias ("haiku") -> "Haiku".
 * Anything else, "(overhead)" included, is returned unchanged.
 */
export function modelLabel(name: string): string {
  const n = NEW_STYLE.exec(name)
  if (n) return `${cap(n[1])} ${n[2]}${n[3] ? `.${n[3]}` : ''}`
  const o = OLD_STYLE.exec(name)
  if (o) return `${cap(o[3])} ${o[1]}${o[2] ? `.${o[2]}` : ''}`
  if (FAMILIES.has(name)) return cap(name)
  return name
}
