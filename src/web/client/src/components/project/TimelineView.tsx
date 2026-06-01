/**
 * Correlated session timeline — multi-lane, day-grouped, time-aligned.
 * Adapted from specs/LEGACY-VISUALIZER.md Part 2.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { ProcessedSession, Segment } from '@/types/model'

// ── Constants ─────────────────────────────────────────────────────────────────

const COL_WIDTH = 560
const COL_GAP = 10
const PX_PER_MINUTE = 3
const MAX_GAP_PX = 100
const CARD_GAP = 6
const LONG_PROMPT_THRESHOLD = 800

// 12-color palette — stable assignment per session
const PALETTE = [
  '#58a6ff',
  '#3fb950',
  '#d29922',
  '#f85149',
  '#bc8cff',
  '#79c0ff',
  '#56d364',
  '#e3b341',
  '#ff7b72',
  '#d2a8ff',
  '#a5d6ff',
  '#7ee787',
]

// ── Types ─────────────────────────────────────────────────────────────────────

interface DayGroup {
  date: string
  lanes: { sessionId: string; session: ProcessedSession; segments: Segment[] }[]
}

interface CardData {
  id: string
  laneIndex: number
  sessionId: string
  segment: Segment
  promptIndex: number
  prompt: string
  summary: string
  timestamp: Date
  colorIndex: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function groupByDay(sessions: ProcessedSession[]): DayGroup[] {
  const dayMap = new Map<string, Map<string, { session: ProcessedSession; segments: Segment[] }>>()

  for (const session of sessions) {
    for (const segment of session.segments) {
      if (!dayMap.has(segment.date)) dayMap.set(segment.date, new Map())
      const day = dayMap.get(segment.date)!
      if (!day.has(session.sessionId)) {
        day.set(session.sessionId, { session, segments: [] })
      }
      day.get(session.sessionId)!.segments.push(segment)
    }
  }

  return Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, sessionMap]) => {
      const lanes = Array.from(sessionMap.entries())
        .map(([sessionId, data]) => ({ sessionId, ...data }))
        .sort((a, b) => {
          const aPrompts = a.segments.reduce((n, s) => n + s.userPrompts.length, 0)
          const bPrompts = b.segments.reduce((n, s) => n + s.userPrompts.length, 0)
          return bPrompts - aPrompts
        })
      return { date, lanes }
    })
}

function assignColors(sessions: ProcessedSession[]): Map<string, number> {
  const sorted = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const map = new Map<string, number>()
  sorted.forEach((s, i) => {
    map.set(s.sessionId, i % PALETTE.length)
  })
  return map
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function formatDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// ── Card Component ────────────────────────────────────────────────────────────

function TurnCard({
  card,
  expanded,
  onToggle,
  style,
  cardRef,
}: {
  card: CardData
  expanded: boolean
  onToggle: () => void
  style: React.CSSProperties
  cardRef: (el: HTMLDivElement | null) => void
}) {
  const color = PALETTE[card.colorIndex]
  const isLong = card.prompt.length > LONG_PROMPT_THRESHOLD
  const showFull = expanded || !isLong

  return (
    <div
      ref={cardRef}
      style={{
        ...style,
        width: COL_WIDTH,
        position: 'absolute',
        borderLeft: `3px solid ${color}`,
        borderTop: `1px solid ${color}33`,
      }}
      className="rounded-sm overflow-hidden"
    >
      {/* User prompt */}
      <div
        className="px-3 py-2 bg-[#161b22] hover:bg-[#1c2333] transition-colors"
        style={{ cursor: isLong ? 'pointer' : 'default' }}
        onClick={isLong ? onToggle : undefined}
      >
        <div className="flex gap-2">
          <span
            className="font-mono text-[10px] tracking-tight text-muted-foreground shrink-0 pt-0.5"
            style={{ letterSpacing: '-0.02em' }}
          >
            {formatTime(card.segment.timeRange[0])}
          </span>
          <div
            className="text-xs leading-relaxed text-[#c9d1d9] whitespace-pre-wrap break-words min-w-0"
            style={
              !showFull
                ? {
                    maxHeight: 200,
                    overflow: 'hidden',
                    maskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)',
                    WebkitMaskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)',
                  }
                : undefined
            }
          >
            {card.prompt}
          </div>
        </div>
      </div>

      {/* Token bar (placeholder — segments don't have per-turn tokens) */}
      <div className="h-[3px] w-full" style={{ backgroundColor: `${color}22` }}>
        <div className="h-full transition-all" style={{ width: '30%', backgroundColor: `${color}99` }} />
      </div>

      {/* Summary */}
      {card.summary && (
        <div className="px-3 py-2 bg-[#0d1117]">
          <p className="text-xs leading-relaxed text-[#8b949e] line-clamp-3">{card.summary}</p>
        </div>
      )}
    </div>
  )
}

// ── Day Section ───────────────────────────────────────────────────────────────

function DaySection({
  day,
  colorMap,
  expandedCards,
  toggleCard,
}: {
  day: DayGroup
  colorMap: Map<string, number>
  expandedCards: Set<string>
  toggleCard: (id: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [positions, setPositions] = useState<Map<string, { top: number; left: number }>>(new Map())
  const [containerHeight, setContainerHeight] = useState(0)

  // Build cards list
  const cards: CardData[] = []
  for (let laneIndex = 0; laneIndex < day.lanes.length; laneIndex++) {
    const lane = day.lanes[laneIndex]
    for (const segment of lane.segments) {
      for (let pi = 0; pi < segment.userPrompts.length; pi++) {
        const id = `${day.date}-${lane.sessionId}-${segment.index}-${pi}`
        cards.push({
          id,
          laneIndex,
          sessionId: lane.sessionId,
          segment,
          promptIndex: pi,
          prompt: segment.userPrompts[pi],
          summary: pi === 0 ? segment.summary : '',
          timestamp: new Date(segment.timeRange[0]),
          colorIndex: colorMap.get(lane.sessionId) ?? 0,
        })
      }
    }
  }

  // Sort by timestamp
  cards.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())

  // Layout computation
  useLayoutEffect(() => {
    if (cards.length === 0) return

    const laneCount = day.lanes.length
    const laneBottom = new Array(laneCount).fill(0)
    let globalYCursor = 0
    let lastTimeMs = cards[0].timestamp.getTime()
    const newPositions = new Map<string, { top: number; left: number }>()

    for (const card of cards) {
      const el = cardRefs.current.get(card.id)
      const measuredHeight = el?.offsetHeight ?? 80

      const timeDelta = (card.timestamp.getTime() - lastTimeMs) / 60_000
      const timeGapPx = Math.min(timeDelta * PX_PER_MINUTE, MAX_GAP_PX)
      globalYCursor += timeGapPx
      lastTimeMs = card.timestamp.getTime()

      const y = Math.max(laneBottom[card.laneIndex], globalYCursor)
      const x = card.laneIndex * (COL_WIDTH + COL_GAP)

      newPositions.set(card.id, { top: y, left: x })
      laneBottom[card.laneIndex] = y + measuredHeight + CARD_GAP
      globalYCursor = Math.max(globalYCursor, y)
    }

    setPositions(newPositions)
    setContainerHeight(Math.max(...laneBottom))
    // biome-ignore lint/correctness/useExhaustiveDependencies: cards is computed inline each render; re-measuring on every pass is intentional
  }, [cards, day.lanes.length])

  const setCardRef = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) cardRefs.current.set(id, el)
      else cardRefs.current.delete(id)
    },
    [],
  )

  return (
    <div className="mb-8">
      {/* Day label */}
      <div className="flex items-center gap-3 mb-3">
        <h3 className="text-sm font-semibold text-foreground">{formatDate(day.date)}</h3>
        <div className="h-px flex-1 bg-border" />
      </div>

      {/* Lane headers */}
      <div className="flex gap-[10px] mb-3">
        {day.lanes.map((lane) => {
          const color = PALETTE[colorMap.get(lane.sessionId) ?? 0]
          const promptCount = lane.segments.reduce((n, s) => n + s.userPrompts.length, 0)
          const name = lane.session.title ?? lane.sessionId.slice(0, 8)
          return (
            <div key={lane.sessionId} style={{ width: COL_WIDTH }} className="flex items-center gap-2 shrink-0">
              <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
              <span className="text-xs font-medium text-foreground/80 truncate">{name}</span>
              <span className="text-[10px] text-muted-foreground">
                {promptCount} turn{promptCount !== 1 ? 's' : ''}
              </span>
            </div>
          )
        })}
      </div>

      {/* Cards container */}
      <div ref={containerRef} className="relative" style={{ height: containerHeight || undefined }}>
        {cards.map((card) => {
          const pos = positions.get(card.id)
          return (
            <TurnCard
              key={card.id}
              card={card}
              expanded={expandedCards.has(card.id)}
              onToggle={() => toggleCard(card.id)}
              cardRef={setCardRef(card.id)}
              style={
                pos
                  ? { top: pos.top, left: pos.left }
                  : { top: 0, left: card.laneIndex * (COL_WIDTH + COL_GAP), visibility: 'hidden' as const }
              }
            />
          )
        })}
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

interface TimelineViewProps {
  sessions: ProcessedSession[]
}

export function TimelineView({ sessions }: TimelineViewProps) {
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set())

  const days = groupByDay(sessions)
  const colorMap = assignColors(sessions)

  const toggleCard = useCallback((id: string) => {
    setExpandedCards((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const expandAll = useCallback(() => {
    const allIds = new Set<string>()
    for (const day of days) {
      for (const lane of day.lanes) {
        for (const segment of lane.segments) {
          for (let pi = 0; pi < segment.userPrompts.length; pi++) {
            if (segment.userPrompts[pi].length > LONG_PROMPT_THRESHOLD) {
              allIds.add(`${day.date}-${lane.sessionId}-${segment.index}-${pi}`)
            }
          }
        }
      }
    }
    setExpandedCards(allIds)
  }, [days])

  const collapseAll = useCallback(() => setExpandedCards(new Set()), [])

  if (sessions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        No preprocessed sessions available.
      </div>
    )
  }

  const totalSegments = sessions.reduce((n, s) => n + s.segments.length, 0)
  const totalPrompts = sessions.reduce((n, s) => n + s.segments.reduce((m, seg) => m + seg.userPrompts.length, 0), 0)

  return (
    <div className="flex h-full flex-col">
      {/* Header bar */}
      <div className="flex items-center gap-4 border-b px-6 py-3 shrink-0">
        <span className="text-xs text-muted-foreground">
          {sessions.length} sessions · {totalSegments} segments · {totalPrompts} prompts · {days.length} days
        </span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={expandAll}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Expand all
          </button>
          <span className="text-xs text-muted-foreground">/</span>
          <button
            type="button"
            onClick={collapseAll}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Collapse all
          </button>
        </div>
      </div>

      {/* Scrollable timeline */}
      <ScrollArea className="flex-1 p-6">
        {days.map((day) => (
          <DaySection
            key={day.date}
            day={day}
            colorMap={colorMap}
            expandedCards={expandedCards}
            toggleCard={toggleCard}
          />
        ))}
      </ScrollArea>
    </div>
  )
}
