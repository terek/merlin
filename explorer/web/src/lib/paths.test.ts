import { expect, test } from 'bun:test'
import { firstLine, resumeCommand, sessionPath, shellQuote, shortProject } from './paths'

test('shortProject keeps the last two segments', () => {
  expect(shortProject('/home/dev/acme/web')).toBe('acme/web')
  expect(shortProject('/home/dev/acme/web/')).toBe('acme/web')
  expect(shortProject('/web')).toBe('web')
  expect(shortProject('C:\\work\\acme\\web')).toBe('acme/web')
  expect(shortProject('/')).toBe('/')
  expect(shortProject('')).toBe('(unknown)')
})

test('resume command', () => {
  expect(resumeCommand('/home/dev/acme', 'abc-1')).toBe('cd /home/dev/acme && claude --resume abc-1')
  expect(resumeCommand('/home/dev/my proj', 'abc')).toBe("cd '/home/dev/my proj' && claude --resume abc")
  expect(resumeCommand(undefined, 'abc')).toBe('claude --resume abc')
  expect(shellQuote("it's")).toBe(`'it'\\''s'`)
})

test('firstLine and sessionPath', () => {
  expect(firstLine('\n\n  hello \nworld')).toBe('hello')
  expect(firstLine('')).toBe('')
  expect(sessionPath({ harness: 'claude', id: 'x y' }, 't3')).toBe('/s/claude/x%20y#t3')
})
