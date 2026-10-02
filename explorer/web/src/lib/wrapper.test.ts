import { describe, expect, test } from 'bun:test'
import { unwrapMachineText } from './wrapper'

describe('unwrapMachineText', () => {
  test('task notification', () => {
    const t = `<task-notification>
<task-id>b12</task-id>
<status>completed</status>
<summary>Background command "build the docs" finished</summary>
<result>All 12 pages built.</result>
</task-notification>`
    const u = unwrapMachineText(t)
    expect(u.label).toBe('completed')
    expect(u.summary).toBe('Background command "build the docs" finished')
    expect(u.body).toBe('Background command "build the docs" finished\n\nAll 12 pages built.')
  })
  test('task notification without a summary or status is left alone', () => {
    const t = '<task-notification>background agent finished</task-notification>'
    expect(unwrapMachineText(t)).toEqual({ label: '', body: t, summary: t })
  })
  test('teammate message with a summary', () => {
    const u = unwrapMachineText(
      '<teammate-message teammate_id="reviewer" summary="Found two issues">\nSee line 4.\nAnd 9.\n</teammate-message>',
    )
    expect(u).toEqual({ label: 'from reviewer', body: 'See line 4.\nAnd 9.', summary: 'Found two issues' })
  })
  test('teammate message with the prefix line, no summary, attributes in any order', () => {
    const u = unwrapMachineText(
      "Another Claude session sent a message:\n<teammate-message summary='x &amp; y' teammate_id='lead'>First line\nsecond</teammate-message>",
    )
    expect(u.label).toBe('from lead')
    expect(u.summary).toBe('x & y')
    expect(u.body).toBe('First line\nsecond')
    const v = unwrapMachineText('<teammate-message teammate_id="lead">First line\nsecond</teammate-message>')
    expect(v.summary).toBe('First line')
  })
  test('cross-session message', () => {
    const u = unwrapMachineText(
      '<cross-session-message from="docs-session">Please rebase.\nThanks.</cross-session-message>',
    )
    expect(u).toEqual({ label: 'from docs-session', body: 'Please rebase.\nThanks.', summary: 'Please rebase.' })
  })
  test('a JSON body shows its result or message', () => {
    const r = unwrapMachineText('<teammate-message teammate_id="a">{"result": "all green", "n": 3}</teammate-message>')
    expect(r.body).toBe('all green')
    const m = unwrapMachineText(
      '<teammate-message teammate_id="a">{"type":"x","message":"hello there"}</teammate-message>',
    )
    expect(m.body).toBe('hello there')
    const other = '{"n": 3}'
    expect(unwrapMachineText(`<teammate-message teammate_id="a">${other}</teammate-message>`).body).toBe(other)
    expect(unwrapMachineText('<teammate-message teammate_id="a">{broken</teammate-message>').body).toBe('{broken')
  })
  test('two messages in one text', () => {
    const u = unwrapMachineText(
      '<teammate-message teammate_id="a" summary="one">A</teammate-message>\n<teammate-message teammate_id="b">B</teammate-message>',
    )
    expect(u.label).toBe('from a')
    expect(u.body).toBe('A\n\nB')
  })
  test('unrecognised text comes back unchanged', () => {
    for (const t of [
      '',
      'Just a prompt.\nSecond line.',
      '<other>thing</other>',
      '<teammate-message teammate_id="a">unterminated',
      'before <teammate-message teammate_id="a">x</teammate-message> after',
      '<task-notification>\n<task-id>1</task-id>\n</task-notification>',
    ]) {
      const u = unwrapMachineText(t)
      expect(u.label).toBe('')
      expect(u.body).toBe(t)
    }
  })
})
