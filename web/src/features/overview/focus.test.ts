import { describe, expect, test } from 'bun:test'
import { withoutFocus } from '../../lib/scope'
import { closedSearch, focusSearch, legacyTarget, openValue, parseOpen, positionIn } from './focus'
import { listRows } from './model'

const rows = ['a', 'b', 'c'].map((id) => ({ harness: 'claude', id }))

describe('open=', () => {
  test('parse and write', () => {
    expect(parseOpen('claude:abc')).toEqual({ harness: 'claude', id: 'abc' })
    expect(parseOpen('codex:a:b')).toEqual({ harness: 'codex', id: 'a:b' })
    expect(parseOpen('claude')).toBeNull()
    expect(parseOpen('claude:')).toBeNull()
    expect(parseOpen(':x')).toBeNull()
    expect(parseOpen(null)).toBeNull()
    expect(openValue({ harness: 'pi', id: '1' })).toBe('pi:1')
  })

  test('opening keeps the scope and drops the previous zoom', () => {
    const q = new URLSearchParams(focusSearch('?range=30d&sort=spend&open=claude:a&sfrom=x&sto=y&pin=3', rows[1]))
    expect(q.get('range')).toBe('30d')
    expect(q.get('sort')).toBe('spend')
    expect(q.get('open')).toBe('claude:b')
    expect(q.has('sfrom') || q.has('sto') || q.has('pin')).toBe(false)
    const z = new URLSearchParams(focusSearch('?range=7d', rows[0], { from: 'F', to: 'T' }))
    expect(z.get('sfrom')).toBe('F')
    expect(z.get('sto')).toBe('T')
  })
})

describe('closing and scope changes', () => {
  test('the focus parameters go, the scope stays', () => {
    expect(closedSearch('?range=30d&open=claude:a&sfrom=x&sto=y')).toBe('?range=30d')
    expect(closedSearch('?open=claude:a')).toBe('')
    expect(withoutFocus('?in=%2Fw&q=hi&open=claude:a&cursor=2').toString()).toBe('in=%2Fw&q=hi')
  })
})

describe('the old session address', () => {
  const key = { harness: 'claude', id: 'abc' }
  test('lands on the last Overview with the session open', () => {
    const to = legacyTarget('/?range=30d&in=%2Fw', key, '', '')
    expect(to).toBe('/?range=30d&in=%2Fw&open=claude%3Aabc')
  })
  test('maps the zoom and carries the hash and the development parameters', () => {
    const to = legacyTarget(
      '/',
      key,
      '?from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&pin=4&unit=u1&cursor=2',
      '#t12',
    )
    const [path, hash] = to.split('#')
    expect(hash).toBe('t12')
    const q = new URLSearchParams(path.split('?')[1])
    expect(q.get('sfrom')).toBe('2026-11-01T00:00:00Z')
    expect(q.get('sto')).toBe('2026-11-02T00:00:00Z')
    expect(q.get('pin')).toBe('4')
    expect(q.get('unit')).toBe('u1')
    expect(q.get('cursor')).toBe('2')
    expect(q.has('from')).toBe(false)
  })
  test('a remembered session is not carried over', () => {
    expect(legacyTarget('/?range=1d&open=claude:old&sfrom=x', key, '', '')).toBe('/?range=1d&open=claude%3Aabc')
  })
})

describe('the list the focus walks', () => {
  test('position and neighbours', () => {
    expect(positionIn(rows, rows[1])).toEqual({ n: 2, total: 3, prev: rows[0], next: rows[2] })
    expect(positionIn(rows, rows[0])?.prev).toBeNull()
    expect(positionIn(rows, rows[2])?.next).toBeNull()
    expect(positionIn(rows, { harness: 'codex', id: 'a' })).toBeNull()
  })

  test('the rows are in the sort the table draws', () => {
    const lane = (id: string, usd: number) =>
      ({
        harness: 'claude',
        id,
        usd,
        turns: 1,
        agents: 0,
        slot0: 0,
        context: [],
        idle: [],
        active: [],
        spans: [],
      }) as never
    const lanes = [lane('a', 1), lane('b', 5), lane('c', 3)]
    const by = 'dir' as const
    const r = listRows(lanes, { term: '', sel: null, by, sort: { key: 'spend', desc: true }, home: undefined })
    expect(r.rows.map((l) => l.id)).toEqual(['b', 'c', 'a'])
    expect(positionIn(r.rows, { harness: 'claude', id: 'c' })?.n).toBe(2)
  })
})
