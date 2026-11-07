import { expect, test } from 'bun:test'
import { describeHarness, type HarnessInfo, harnessTitles } from './harnesses'

const list: HarnessInfo[] = [
  { name: 'claude', title: 'Claude Code', resume: 'claude --resume {id}' },
  { name: 'codex', title: 'Codex', resume: 'codex resume {id}', badge: 'codex' },
]

test('a listed harness is described by the list', () => {
  expect(describeHarness(list, 'codex').badge).toBe('codex')
  expect(describeHarness(list, 'claude').title).toBe('Claude Code')
})

test('an unlisted harness borrows nothing from Claude', () => {
  expect(describeHarness(list, 'pi')).toEqual({ name: 'pi', title: 'pi', badge: 'pi' })
})

test('while loading there is no badge and no resume command', () => {
  expect(describeHarness(undefined, 'codex')).toEqual({ name: 'codex', title: 'codex' })
})

test('titles read as a list', () => {
  expect(harnessTitles(list, ['claude'])).toBe('Claude Code')
  expect(harnessTitles(list, ['claude', 'codex'])).toBe('Claude Code and Codex')
  expect(harnessTitles(list, ['claude', 'codex', 'pi'])).toBe('Claude Code, Codex and pi')
})
