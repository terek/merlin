// Finding a term in an open session (docs/ui.md section 10b, "Find"): a case-insensitive substring over the texts
// of the loaded tree, as the list of turns (or pieces of agent work) that hold it. Pure; the box is in ScopeSlot.tsx.

import type { Agent, Compaction, Turn } from '../../api/types'

/** What of a tree the search reads (a `Tree` of the spend model has all of it). */
export interface FindBranch {
  index: number
  model: {
    cols: readonly {
      index: number
      inherited: boolean
      turn: Pick<Turn, 'userText' | 'queued' | 'finalText' | 'startedAt'>
      compactions: readonly Compaction[]
    }[]
    agentsById: ReadonlyMap<string, Agent>
    units: readonly { id: string; launch: number; ordinal: number; agent: Agent; nested: readonly Agent[] }[]
  }
}

/** A turn (and, for agent work, the piece of work opened with it) that holds the term. */
export interface Hit {
  branch: number
  col: number
  /** The piece of agent work the text belongs to. */
  unit?: string
  /** When the first matching text was written (ms; NaN when unknown). */
  t: number
}

/** The ranges `[from, to)` of `text` the term matches, case-insensitively. */
export function matchRanges(text: string, term: string, skip: readonly { from: number; to: number }[] = []) {
  const out: { from: number; to: number }[] = []
  const needle = term.toLowerCase()
  if (!needle || !text) return out
  const hay = text.toLowerCase()
  // lower-casing can change a string's length (a few letters): then offsets are not trusted, and nothing matches
  if (hay.length !== text.length) return out
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
    const to = i + needle.length
    if (!skip.some((s) => i < s.to && to > s.from)) out.push({ from: i, to })
  }
  return out
}

/** Byte ranges (UTF-8) of a text as character ranges of the string. */
function byteToChars(text: string, ranges: readonly { from: number; to: number }[]) {
  if (ranges.length === 0) return []
  const enc = new TextEncoder()
  const at = (b: number) => {
    // the character offset of byte b: walk the string
    let bytes = 0
    let i = 0
    while (i < text.length && bytes < b) {
      const cp = text.codePointAt(i) as number
      bytes += enc.encode(String.fromCodePoint(cp)).length
      i += cp > 0xffff ? 2 : 1
    }
    return i
  }
  return ranges.map((r) => ({ from: at(r.from), to: at(r.to) }))
}

const ms = (s: string | undefined) => (s ? Date.parse(s) : Number.NaN)
const has = (text: string | undefined, term: string, skip?: Compaction['boilerplate']) =>
  !!text && matchRanges(text, term, skip ? byteToChars(text, skip) : []).length > 0

/** The turns and pieces of agent work holding `term`, in time order (the term is trimmed; none for an empty one). */
export function findHits(branches: readonly FindBranch[], rawTerm: string): Hit[] {
  const term = rawTerm.trim()
  if (!term) return []
  const found = new Map<string, Hit>()
  const add = (h: Hit) => {
    const key = `${h.branch}/${h.col}/${h.unit ?? ''}`
    const old = found.get(key)
    if (!old || h.t < old.t) found.set(key, h)
  }
  for (const b of branches) {
    for (const c of b.model.cols) {
      if (c.inherited) continue
      const t = c.turn
      const at = ms(t.startedAt)
      const here = (when: number) => add({ branch: b.index, col: c.index, t: Number.isFinite(when) ? when : at })
      if (has(t.userText, term)) here(at)
      for (const q of t.queued ?? []) if (has(q.text, term)) here(ms(q.at))
      if (has(t.finalText, term)) here(at)
      for (const cp of c.compactions) if (has(cp.summary, term, cp.boilerplate)) here(ms(cp.at))
    }
    for (const a of b.model.agentsById.values()) {
      const unitFor = (turn: number) => {
        const mine = b.model.units.filter((u) => u.agent.id === a.id || u.nested.some((n) => n.id === a.id))
        return mine.find((u) => u.agent.id === a.id && u.ordinal - 1 === turn) ?? mine[0]
      }
      const hitAt = (turn: number, when: number) => {
        const u = unitFor(turn)
        if (u) add({ branch: b.index, col: u.launch, unit: u.id, t: when })
      }
      const turns = a.turns ?? []
      if (turns.length === 0) {
        if (has(a.prompt, term) || has(a.finalText, term)) hitAt(0, ms(a.startedAt))
      }
      for (const [k, t] of turns.entries()) {
        const when = ms(t.startedAt)
        if (has(t.prompt, term) || has(t.finalText, term) || (t.queued ?? []).some((q) => has(q.text, term)))
          hitAt(k, when)
      }
      for (const cp of a.compactions ?? []) if (has(cp.summary, term, cp.boilerplate)) hitAt(0, ms(cp.at))
    }
  }
  const nan = (n: number) => (Number.isFinite(n) ? n : Number.POSITIVE_INFINITY)
  return [...found.values()].sort(
    (x, y) => nan(x.t) - nan(y.t) || x.branch - y.branch || x.col - y.col || (x.unit ?? '').localeCompare(y.unit ?? ''),
  )
}

/** The hit a pinned turn (and open piece of work) is, or -1. */
export function hitIndex(hits: readonly Hit[], pin: { branch: number; col: number } | null, unit: string | null) {
  if (!pin) return -1
  return hits.findIndex((h) => h.branch === pin.branch && h.col === pin.col && (h.unit ?? null) === unit)
}

/** The index a step of `dir` from `at` (-1: none yet) goes to, wrapping; -1 without hits. */
export function stepIndex(at: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1
  if (at < 0) return dir === 1 ? 0 : count - 1
  return (at + dir + count) % count
}
