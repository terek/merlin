import { expect, test } from 'bun:test'
import { modelLabel } from './models'

test('modelLabel', () => {
  expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1')
  expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelLabel('claude-sonnet-4-20250514')).toBe('Sonnet 4')
  expect(modelLabel('claude-opus-4-1-20250805')).toBe('Opus 4.1')
  expect(modelLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
  expect(modelLabel('claude-3-haiku-20240307')).toBe('Haiku 3')
  expect(modelLabel('claude-opus-4-1[1m]')).toBe('Opus 4.1')
  expect(modelLabel('haiku')).toBe('Haiku')
})

test('unknown names are unchanged', () => {
  expect(modelLabel('(overhead)')).toBe('(overhead)')
  expect(modelLabel('gpt-9')).toBe('gpt-9')
  expect(modelLabel('claude-mystery-7')).toBe('claude-mystery-7')
  expect(modelLabel('')).toBe('')
})
