import { expect, test } from 'bun:test'
import { highlightSnippet, queryTerms } from './highlight'

const join = (s: { text: string }[]) => s.map((x) => x.text).join('')

test('marks terms case-insensitively and keeps the text', () => {
  const segs = highlightSnippet('Write the Changelog for changelogs', 'changelog')
  expect(join(segs)).toBe('Write the Changelog for changelogs')
  expect(segs.filter((s) => s.match).map((s) => s.text)).toEqual(['Changelog', 'changelog'])
})

test('several terms, longest first', () => {
  const segs = highlightSnippet('fooBar foo', 'foo fooBar')
  expect(segs.filter((s) => s.match).map((s) => s.text)).toEqual(['fooBar', 'foo'])
})

test('regex metacharacters are literal', () => {
  const text = 'a.b axb (x) [y] c++ $5 ^ \\ | ? * {1}'
  expect(
    highlightSnippet(text, 'a.b')
      .filter((s) => s.match)
      .map((s) => s.text),
  ).toEqual(['a.b'])
  for (const q of ['(x)', '[y]', 'c++', '$5', '^', '\\', '|', '?', '*', '{1}', '.', '-', '/']) {
    const segs = highlightSnippet(text, q)
    expect(join(segs)).toBe(text)
  }
  expect(
    highlightSnippet(text, '(x)')
      .filter((s) => s.match)
      .map((s) => s.text),
  ).toEqual(['(x)'])
  expect(
    highlightSnippet(text, 'c++')
      .filter((s) => s.match)
      .map((s) => s.text),
  ).toEqual(['c++'])
  expect(
    highlightSnippet(text, '*')
      .filter((s) => s.match)
      .map((s) => s.text),
  ).toEqual(['*'])
})

test('empty inputs', () => {
  expect(highlightSnippet('', 'x')).toEqual([])
  expect(highlightSnippet('abc', '')).toEqual([{ text: 'abc', match: false }])
  expect(highlightSnippet('abc', '   ')).toEqual([{ text: 'abc', match: false }])
  expect(highlightSnippet('abc', 'zzz')).toEqual([{ text: 'abc', match: false }])
})

test('queryTerms dedupes', () => {
  expect(queryTerms('a  A bb')).toEqual(['bb', 'a'])
})
