import { expect, test } from 'bun:test'
import { agentRole } from './agent'

test('agentRole reads the facets of a sub-agent', () => {
  expect(agentRole({ kind: 'subagent' })).toBe('subagent')
  expect(agentRole({ kind: 'subagent', addressable: true })).toBe('addressable')
  expect(agentRole({ kind: 'subagent', inheritsContext: true, addressable: true })).toBe('fork')
  expect(agentRole({ kind: 'compact', inheritsContext: true })).toBe('compact')
  expect(agentRole({ kind: 'review' })).toBe('review')
})

test('agentRole reads the kinds of schema 1', () => {
  expect(agentRole({ kind: 'teammate' })).toBe('addressable')
  expect(agentRole({ kind: 'fork' })).toBe('fork')
})
