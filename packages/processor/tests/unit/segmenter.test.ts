import { describe, expect, test } from 'bun:test'
import type { LeanTurn } from '../../src/schema.ts'
import { SegmentSchema } from '../../src/segment-schema.ts'
import { segmentByDay } from '../../src/segmenter.ts'

function makeTurn(index: number, date: string, minuteOffset: number, userText: string): LeanTurn {
  const ts = `${date}T${String(10 + Math.floor(minuteOffset / 60)).padStart(2, '0')}:${String(minuteOffset % 60).padStart(2, '0')}:00.000Z`
  const responseTs = `${date}T${String(10 + Math.floor((minuteOffset + 2) / 60)).padStart(2, '0')}:${String((minuteOffset + 2) % 60).padStart(2, '0')}:00.000Z`
  return {
    id: `aaaabbbb-${String(index).padStart(4, '0')}`,
    index,
    userText,
    userTimestamp: ts,
    agentText: `Response to: ${userText}`,
    agentTimestamp: responseTs,
    durationMs: 120000,
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 30 },
    rawMessageCount: 1,
    subagents: [],
  }
}

describe('segmentByDay', () => {
  test('empty turns -> empty segments', () => {
    expect(segmentByDay([])).toEqual([])
  })

  test('single day -> single segment', () => {
    const turns = [
      makeTurn(0, '2026-03-15', 0, 'Fix the auth module'),
      makeTurn(1, '2026-03-15', 5, 'Add rate limiting'),
      makeTurn(2, '2026-03-15', 10, 'Write tests'),
    ]

    const segments = segmentByDay(turns)
    expect(segments).toHaveLength(1)

    const seg = segments[0]!
    expect(seg.index).toBe(0)
    expect(seg.date).toBe('2026-03-15')
    expect(seg.turnRange).toEqual([0, 3])
    expect(seg.userPrompts).toHaveLength(3)
    expect(seg.userPrompts[0]).toBe('Fix the auth module')
  })

  test('multi-day -> one segment per day', () => {
    const turns = [
      makeTurn(0, '2026-03-15', 0, 'Day 1 task A'),
      makeTurn(1, '2026-03-15', 5, 'Day 1 task B'),
      makeTurn(2, '2026-03-16', 0, 'Day 2 task A'),
      makeTurn(3, '2026-03-17', 0, 'Day 3 task A'),
    ]

    const segments = segmentByDay(turns)
    expect(segments).toHaveLength(3)

    expect(segments[0]!.date).toBe('2026-03-15')
    expect(segments[0]!.turnRange).toEqual([0, 2])
    expect(segments[0]!.userPrompts).toHaveLength(2)

    expect(segments[1]!.date).toBe('2026-03-16')
    expect(segments[1]!.turnRange).toEqual([2, 3])
    expect(segments[1]!.userPrompts).toHaveLength(1)

    expect(segments[2]!.date).toBe('2026-03-17')
    expect(segments[2]!.turnRange).toEqual([3, 4])
  })

  test('segment indices are sequential', () => {
    const turns = [
      makeTurn(0, '2026-03-15', 0, 'A'),
      makeTurn(1, '2026-03-16', 0, 'B'),
      makeTurn(2, '2026-03-17', 0, 'C'),
    ]

    const segments = segmentByDay(turns)
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2])
  })

  test('topic is truncated first user prompt', () => {
    const longPrompt = 'A'.repeat(100)
    const turns = [makeTurn(0, '2026-03-15', 0, longPrompt)]

    const segments = segmentByDay(turns)
    expect(segments[0]!.topic.length).toBeLessThanOrEqual(60)
    expect(segments[0]!.topic.endsWith('...')).toBe(true)
  })

  test('topic uses first line of first prompt', () => {
    const turns = [makeTurn(0, '2026-03-15', 0, 'Fix the bug\nMore details here')]

    const segments = segmentByDay(turns)
    expect(segments[0]!.topic).toBe('Fix the bug')
  })

  test('summary lists all user prompts', () => {
    const turns = [makeTurn(0, '2026-03-15', 0, 'Task one'), makeTurn(1, '2026-03-15', 5, 'Task two')]

    const segments = segmentByDay(turns)
    expect(segments[0]!.summary).toContain('Task one')
    expect(segments[0]!.summary).toContain('Task two')
  })

  test('time range spans first user to last agent timestamp', () => {
    const turns = [makeTurn(0, '2026-03-15', 0, 'First'), makeTurn(1, '2026-03-15', 30, 'Last')]

    const segments = segmentByDay(turns)
    const seg = segments[0]!
    expect(seg.timeRange[0]).toBe(turns[0]!.userTimestamp)
    expect(seg.timeRange[1]).toBe(turns[1]!.agentTimestamp)
  })

  test('usage is aggregated across turns', () => {
    const turns = [makeTurn(0, '2026-03-15', 0, 'A'), makeTurn(1, '2026-03-15', 5, 'B')]

    const segments = segmentByDay(turns)
    expect(segments[0]!.usage).not.toBeNull()
    expect(segments[0]!.usage!.inputTokens).toBe(200) // 100+100
    expect(segments[0]!.usage!.outputTokens).toBe(100) // 50+50
  })

  test('usage is null when turns have no usage', () => {
    const turns: LeanTurn[] = [
      {
        id: 'aaaabbbb-0000',
        index: 0,
        userText: 'Hi',
        userTimestamp: '2026-03-15T10:00:00.000Z',
        agentText: 'Hello',
        agentTimestamp: '2026-03-15T10:01:00.000Z',
        durationMs: 60000,
        usage: null,
        rawMessageCount: 1,
        subagents: [],
      },
    ]

    const segments = segmentByDay(turns)
    expect(segments[0]!.usage).toBeNull()
  })

  test('all segments validate against SegmentSchema', () => {
    const turns = [makeTurn(0, '2026-03-15', 0, 'Day 1'), makeTurn(1, '2026-03-16', 0, 'Day 2')]

    const segments = segmentByDay(turns)
    for (const seg of segments) {
      const result = SegmentSchema.safeParse(seg)
      if (!result.success) {
        console.error('Validation failed:', result.error.format())
      }
      expect(result.success).toBe(true)
    }
  })
})
