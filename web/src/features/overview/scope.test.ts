import { describe, expect, test } from 'bun:test'
import cases from '../../../../testdata/place-scope.json'
import { type By, underPath } from './model'

// The same table the Go test of catalog.UnderPath reads: the two cannot drift.
describe('underPath against testdata/place-scope.json', () => {
  for (const c of cases.cases) {
    test(`${c.by} ${JSON.stringify(c.key)} in ${JSON.stringify(c.in)}`, () => {
      expect(underPath(c.key, c.in === '' ? null : c.in, c.by as By)).toBe(c.want)
    })
  }
})
