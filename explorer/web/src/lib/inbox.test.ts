import { describe, expect, test } from 'bun:test'
import type { InboxMessage } from '../api/types'
import { inboxBody, inboxLabel, inboxSummary, turnPrompt } from './inbox'

const at = '2026-09-30T10:00:00Z'
const msg = (m: Partial<InboxMessage>): InboxMessage => ({ at, kind: 'message', ...m })

describe('inbox messages', () => {
  test('labels say who or what the message came from', () => {
    expect(inboxLabel(msg({ from: 'reviewer' }))).toBe('from reviewer')
    expect(inboxLabel(msg({}))).toBe('message')
    expect(inboxLabel(msg({ kind: 'idle', from: 'reviewer', status: 'available' }))).toBe('reviewer idle')
    expect(inboxLabel(msg({ kind: 'idle', from: 'reviewer', status: 'failed' }))).toBe('reviewer idle (failed)')
    expect(inboxLabel(msg({ kind: 'idle' }))).toBe('teammate idle')
    expect(inboxLabel(msg({ kind: 'task', status: 'completed' }))).toBe('task completed')
    expect(inboxLabel(msg({ kind: 'task' }))).toBe('task event')
    expect(inboxLabel(msg({ kind: 'assignment', from: 'team-lead' }))).toBe('task assigned by team-lead')
  })
  test('summary falls back to the error, then to the first line of the text', () => {
    expect(inboxSummary(msg({ summary: 'two nits', text: 'long\ntext' }))).toBe('two nits')
    expect(inboxSummary(msg({ kind: 'idle', error: 'API error', text: '' }))).toBe('API error')
    expect(inboxSummary(msg({ text: 'first\nsecond' }))).toBe('first')
    expect(inboxSummary(msg({ kind: 'idle' }))).toBe('')
  })
  test('body joins summary, error and text once each', () => {
    expect(inboxBody(msg({ summary: 'done', text: 'done' }))).toBe('done')
    expect(inboxBody(msg({ summary: 'two nits', text: 'line 4 and 9' }))).toBe('two nits\n\nline 4 and 9')
    expect(inboxBody(msg({ kind: 'idle' }))).toBe('')
  })
})

describe('turnPrompt', () => {
  test('a typed prompt is itself', () => {
    expect(turnPrompt({ userText: 'fix the test\nand the docs' })).toEqual({
      label: '',
      body: 'fix the test\nand the docs',
      summary: 'fix the test',
    })
  })
  test('one delivered message', () => {
    const p = turnPrompt({
      userText: '',
      inbox: [msg({ from: 'reviewer', summary: 'two nits', text: 'line 4 and 9' })],
    })
    expect(p).toEqual({ label: 'from reviewer', body: 'two nits\n\nline 4 and 9', summary: 'two nits' })
  })
  test('several delivered messages, and text the parser left', () => {
    const p = turnPrompt({
      userText: 'something else',
      inbox: [
        msg({ from: 'reviewer', summary: 'done', text: 'All checked.' }),
        msg({ kind: 'idle', from: 'reviewer', status: 'available', text: 'Final answer.' }),
      ],
    })
    expect(p.label).toBe('from reviewer +1')
    expect(p.summary).toBe('done')
    expect(p.body).toBe('from reviewer\ndone\n\nAll checked.\n\nreviewer idle\nFinal answer.\n\nsomething else')
  })
  test('a digest written before the API parsed the prompt', () => {
    const p = turnPrompt({
      userText:
        'Another Claude session sent a message:\n<teammate-message teammate_id="builder" summary="tests pass">\nall green\n</teammate-message>\n\nThis came from another Claude session, not typed by your user.',
    })
    expect(p).toEqual({ label: 'from builder', body: 'all green', summary: 'tests pass' })
  })
})
