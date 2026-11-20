import { describe, expect, test } from 'bun:test'
import { jobLabel, jobWhat } from './jobs'
import type { JobMark } from './timeline'

describe('jobWhat', () => {
  test('a leading wait or watch phrase goes', () => {
    expect(jobWhat('Wait for the release workflow to finish')).toBe('release workflow to finish')
    expect(jobWhat('Wait again for the re-run to finish')).toBe('re-run to finish')
    expect(jobWhat('wait for BM25 eval judging')).toBe('BM25 eval judging')
    expect(jobWhat('wait for single-book re-annotation')).toBe('single-book re-annotation')
    expect(jobWhat('Wait until prod serves the new build')).toBe('prod serves the new build')
    expect(jobWhat('Watch the median book run')).toBe('median book run')
    expect(jobWhat('Watch the v0.6.2 release workflow until it finishes')).toBe(
      'v0.6.2 release workflow until it finishes',
    )
    expect(jobWhat('WAIT  AGAIN   FOR   THE  re-run')).toBe('re-run')
  })
  test('anything else is left alone', () => {
    expect(jobWhat('Wait 90s, check n=500 progress')).toBe('Wait 90s, check n=500 progress')
    expect(jobWhat('Poll prod until the build is up')).toBe('Poll prod until the build is up')
    expect(jobWhat('Waiting room demo')).toBe('Waiting room demo')
    expect(jobWhat('')).toBe('')
  })
  test('an empty rest gives the original back', () => {
    expect(jobWhat('Wait for the ')).toBe('Wait for the ')
    expect(jobWhat('Watch the')).toBe('Watch the')
  })
})

describe('jobLabel', () => {
  const mark = (description: string): JobMark => ({
    id: 'j1',
    kind: 'command',
    description,
    command: '',
    status: 'completed',
    startMs: 0,
    endMs: 90_000,
    open: false,
    fromKey: '',
    from: '',
    returns: [],
  })
  test('the label uses the stripped text', () => {
    const label = jobLabel(mark('Wait for the release workflow to finish'), 400)
    expect(label.startsWith('release workflow to finish')).toBe(true)
    expect(label).not.toContain('Wait')
  })
})
