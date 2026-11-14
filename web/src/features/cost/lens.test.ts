import { describe, expect, test } from 'bun:test'
import type { OverviewLane } from '../../api/types'
import { buildPlaceTree, placeItems } from '../overview/model'
import { migrateCostSearch, placeRows } from './lens'

const today = new Date(2026, 10, 14, 15, 0)
const mig = (s: string, first: string | null = null) => {
  const r = migrateCostSearch(new URLSearchParams(s), today, first)
  return r instanceof URLSearchParams ? r.toString() : r
}

describe('migrateCostSearch', () => {
  test('new addresses are left alone', () => {
    expect(mig('range=30d&by=repo&in=%2Fw&q=x&stack=source')).toBeNull()
    expect(mig('from=2026-11-01&to=2026-11-03')).toBeNull()
    expect(mig('')).toBeNull()
  })
  test('project is a folder selection', () => {
    expect(mig('project=%2FUsers%2Fdev%2Fmerlin')).toBe('by=dir&in=%2FUsers%2Fdev%2Fmerlin')
  })
  test('90d is 90 whole days ending today', () => {
    expect(mig('range=90d&stack=source')).toBe('stack=source&from=2026-08-17&to=2026-11-14')
  })
  test('all starts at the first day with spend, once it is known', () => {
    expect(mig('range=all')).toBe('wait')
    expect(mig('range=all', '2026-05-02')).toBe('from=2026-05-02&to=2026-11-14')
  })
  test('the cuts go; a lone from is one day', () => {
    expect(mig('repocut=remote&beadcut=bead&range=7d')).toBe('range=7d')
    expect(mig('from=2026-11-03')).toBe('from=2026-11-03&to=2026-11-03')
  })
  test('all together', () => {
    expect(mig('project=%2Fw%2Fa&range=90d&repocut=repo')).toBe('by=dir&in=%2Fw%2Fa&from=2026-08-17&to=2026-11-14')
  })
})

const lane = (id: string, dir: string, usd: number, extra: Partial<OverviewLane> = {}): OverviewLane =>
  ({
    harness: 'claude',
    id,
    dir,
    usd,
    turns: 1,
    agents: 0,
    slot0: 0,
    context: [],
    idle: [],
    active: [],
    spans: [],
    ...extra,
  }) as OverviewLane

const lanes = [
  lane('1', '/w/acme/api', 5),
  lane('2', '/w/acme/web', 3),
  lane('3', '/w/acme', 1),
  lane('4', '/w/oss/cli', 7),
  lane('5', '', 2),
]
const label = (n: { label: string }) => ({ text: n.label, closed: false })
const rows = (sel: string | null, term = '') => placeRows(lanes, { by: 'dir', sel, term, home: undefined, label })

describe('placeRows', () => {
  test('the top-level places by spend, (none) last', () => {
    const r = rows(null)
    expect(r.rows.map((x) => [x.text, x.usd, x.drill])).toEqual([
      ['/w', 16, true],
      ['(none)', 2, false],
    ])
    expect(r.total).toBe(18)
  })
  test('the children of a folder rank by spend; the figures are the tree’s', () => {
    const tree = buildPlaceTree(placeItems(lanes, 'dir'), 'dir', undefined)
    const w = tree.nodes[0]
    const r = rows('/w')
    expect(r.rows.map((x) => [x.text, x.usd])).toEqual([
      ['acme', 9],
      ['oss/cli', 7],
    ])
    expect(r.rows.map((x) => x.usd).reduce((a, b) => a + b, 0)).toBe(w.usd)
  })
  test('a selected folder: its children, and what sits directly in it', () => {
    const r = rows('/w/acme')
    expect(r.rows.map((x) => [x.text, x.usd, x.drill])).toEqual([
      ['api', 5, false],
      ['web', 3, false],
      ['(directly here)', 1, false],
    ])
  })
  test('a selected leaf is one row; (none) is one row', () => {
    expect(rows('/w/oss/cli').rows.map((x) => x.usd)).toEqual([7])
    expect(rows('-').rows.map((x) => [x.text, x.usd])).toEqual([['(none)', 2]])
  })
  test('the search narrows the tree', () => {
    const l = [lane('1', '/w/a/x', 5, { title: 'fix the thing' }), lane('2', '/w/a/y', 3, { title: 'other' })]
    const r = placeRows(l, { by: 'dir', sel: null, term: 'thing', home: undefined, label })
    expect(r.rows.map((x) => x.usd)).toEqual([5])
  })
})
