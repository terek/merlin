// The shareable card: an SVG 1056 wide and as tall as its longest column needs (about 730 to
// 1080), close to square for a feed. It is an image meant to leave the app, so it has a fixed look
// of its own that does not follow the app's theme; its colours are the constants below, not the
// app's tokens. The drawings are inlined as data URLs so that the SVG stands alone (serialised, or
// drawn on a canvas, it still carries them).

import { forwardRef } from 'react'
import type { MomentPersona, MomentsReport } from '../../api/types'
import borisUrl from './avatars/boris.webp?inline'
import karpathyUrl from './avatars/karpathy.webp?inline'
import merlinUrl from './avatars/merlin.webp?inline'
import yeggeUrl from './avatars/yegge.webp?inline'
import { type CardColumn, cardColumns, cardHandle, cardStats, cardSummary } from './model'

const BG = '#f6f2fd'
const INK = '#23163f'
const BODY = '#3d2f63'
const MUTED = '#6f6296'
const FAINT = '#9a8fbd'
const PURPLE = '#8b5cf6'
const PILL = '#ebe3fb'
const PANEL = '#fcfaff'
const STROKE = '#c2b1ef'
const HILL_1 = '#ece4fa'
const HILL_2 = '#e2d6f7'
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const EMOJI = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif'

/**
 * A drawing and where its round backdrop sits, as fractions of the drawing's width (cx, r) and
 * height (cy): the clip keeps the circle and lets the hair rise above it.
 */
interface Avatar {
  url: string
  w: number
  h: number
  cx: number
  cy: number
  r: number
}

export const AVATARS: Record<MomentPersona, Avatar> = {
  karpathy: { url: karpathyUrl, w: 206, h: 260, cx: 0.47, cy: 0.67, r: 0.45 },
  boris: { url: borisUrl, w: 203, h: 260, cx: 0.48, cy: 0.67, r: 0.46 },
  yegge: { url: yeggeUrl, w: 217, h: 260, cx: 0.48, cy: 0.67, r: 0.47 },
}

const PAD = 40
const GAP = 20
const COL_W = 312 // fits the longest title with its NEW tag
const COL_Y = 286
const ITEM_Y = 230 // the first moment's baseline in a column
const ITEM_DY = 42
const FOOT_H = 112 // below the columns: the hills and the mark
const AV_H = 124 // the drawing's height on the card
const FACE_Y = 28 // the drawing's top in a column; the bubble sits 12 above it
const NAME_X = 120 // the name and the focus: right of the drawing, under the bubble
const PER_COL = 10 // moments listed per persona
const STAT_W = 250
const CARD_W = 2 * PAD + 3 * COL_W + 2 * GAP

/**
 * The focus pill's width and font size: the text shrinks rather than leave the panel. The text is
 * drawn centred in the pill, so a rough width estimate still leaves even margins.
 */
function pillFit(text: string): { w: number; size: number } {
  const room = COL_W - NAME_X - 16
  const at13 = text.length * 7.4 // rough width of 13px semibold system text
  const size = Math.max(10.5, Math.min(13, (13 * (room - 28)) / at13))
  return { w: Math.min(room, (at13 * size) / 13 + 28), size }
}

/** A four-pointed sparkle centred on (x, y). */
function Sparkle({ x, y, s, fill = PURPLE }: { x: number; y: number; s: number; fill?: string }) {
  const k = s * 0.22
  return (
    <path
      d={`M${x} ${y - s} Q${x + k} ${y - k} ${x + s} ${y} Q${x + k} ${y + k} ${x} ${y + s} Q${x - k} ${y + k} ${x - s} ${y} Q${x - k} ${y - k} ${x} ${y - s}Z`}
      fill="none"
      stroke={fill}
      strokeWidth={2.2}
      strokeLinejoin="round"
    />
  )
}

function Face({ id, x, y }: { id: MomentPersona; x: number; y: number }) {
  const a = AVATARS[id]
  const h = AV_H
  const w = (a.w / a.h) * h
  const cx = a.cx * w
  const cy = a.cy * h
  const r = a.r * w
  const clip = `mc-face-${id}`
  return (
    <g transform={`translate(${x} ${y})`}>
      <defs>
        <clipPath id={clip}>
          <circle cx={cx} cy={cy} r={r} />
          <rect x={cx - r + 3} y={3} width={2 * r - 6} height={cy} />
        </clipPath>
      </defs>
      <image href={a.url} width={w} height={h} clipPath={`url(#${clip})`} />
    </g>
  )
}

/**
 * The persona's reaction, as a comment bubble on the drawing: one outline, a rounded box whose
 * bottom-left corner runs out into the tail.
 */
const BUBBLE = 'M16 0H40A16 16 0 0 1 56 16V28A16 16 0 0 1 40 44H24L0 53L8.5 42.1A16 16 0 0 1 0 28V16A16 16 0 0 1 16 0Z'

function Reaction({ emoji, x, y }: { emoji: string; x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path d={BUBBLE} fill="#ffffff" stroke={STROKE} strokeWidth={2} strokeLinejoin="round" />
      <text x={28} y={32} textAnchor="middle" fontSize={27} fontFamily={EMOJI}>
        {emoji}
      </text>
    </g>
  )
}

/** How tall the columns are: as tall as the longest list needs, so a short history leaves no void. */
function columnHeight(cols: CardColumn[]): number {
  const items = Math.max(1, ...cols.map((c) => c.items.length))
  const more = cols.some((c) => c.more > 0) ? 30 : 0
  return Math.max(330, ITEM_Y + (items - 1) * ITEM_DY + 40 + more)
}

function Column({ col, x, h }: { col: CardColumn; x: number; h: number }) {
  const focus = pillFit(col.persona.focus)
  const space = col.persona.name.indexOf(' ')
  const [first, last] =
    space < 0 ? [col.persona.name, ''] : [col.persona.name.slice(0, space), col.persona.name.slice(space + 1)]
  return (
    <g transform={`translate(${x} ${COL_Y})`}>
      <rect width={COL_W} height={h} rx={22} fill={PANEL} stroke={STROKE} strokeWidth={2} />
      <Face id={col.persona.id} x={14} y={FACE_Y} />
      <Reaction emoji={col.persona.reaction} x={90} y={FACE_Y - 12} />
      <text x={NAME_X} y={102} fontSize={25} fontWeight={800} fill={INK} fontFamily={FONT}>
        <tspan x={NAME_X}>{first}</tspan>
        <tspan x={NAME_X} dy={28}>
          {last}
        </tspan>
      </text>
      <rect x={NAME_X - 2} y={144} width={focus.w} height={26} rx={13} fill={PILL} />
      <text
        x={NAME_X - 2 + focus.w / 2}
        y={162}
        textAnchor="middle"
        fontSize={focus.size}
        fontWeight={600}
        fill={BODY}
        fontFamily={FONT}
      >
        {col.persona.focus}
      </text>
      <line x1={20} y1={188} x2={COL_W - 20} y2={188} stroke={PILL} strokeWidth={2} />
      {col.items.length === 0 ? (
        <text x={22} y={ITEM_Y} fontSize={18} fill={FAINT} fontFamily={FONT}>
          {col.persona.id === 'yegge' ? 'Waiting for the first experiment' : 'Nothing yet'}
        </text>
      ) : (
        col.items.map((it, i) => {
          const y = ITEM_Y + i * ITEM_DY
          return (
            <g key={it.id}>
              {it.status === 'habit' ? (
                <circle cx={28} cy={y - 6} r={6.5} fill={PURPLE} />
              ) : (
                <circle cx={28} cy={y - 6} r={5.5} fill="none" stroke={PURPLE} strokeWidth={2.2} />
              )}
              <text x={44} y={y} fontSize={18} fontWeight={500} fill={BODY} fontFamily={FONT}>
                {it.title}
                {it.isNew && (
                  <tspan dx={6} fontSize={11} fontWeight={800} fill={PURPLE} letterSpacing={1}>
                    NEW
                  </tspan>
                )}
              </text>
            </g>
          )
        })
      )}
      {col.more > 0 && (
        <text x={44} y={h - 24} fontSize={16} fill={FAINT} fontFamily={FONT}>
          and {col.more} more
        </text>
      )}
    </g>
  )
}

export const MomentCard = forwardRef<SVGSVGElement, { report: MomentsReport; handle: string; className?: string }>(
  function MomentCard({ report, handle, className }, ref) {
    const cols = cardColumns(report, PER_COL)
    const colH = columnHeight(cols)
    const cardH = COL_Y + colH + FOOT_H
    const stats = cardStats(report)
    const sum = cardSummary(report)
    const h = cardHandle(handle)
    const title = h ? `${h}'s Agentic Coding Moments` : 'My Agentic Coding Moments'
    const titleSize = Math.min(52, (CARD_W - 2 * PAD - 110) / (title.length * 0.56))
    const half = (title.length * titleSize * 0.56) / 2 // rough half width of the title
    const statsX = (CARD_W - stats.length * STAT_W) / 2
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${CARD_W} ${cardH}`}
        width={CARD_W}
        height={cardH}
        className={className}
        role="img"
        aria-label={`Merlin card: ${stats.map((s) => `${s.value} ${s.label}`).join(', ')}; ${sum.seen} of ${sum.total} moments`}
      >
        <rect width={CARD_W} height={cardH} fill={BG} />
        {/* clouds in the top corners, hills along the bottom */}
        <g fill={HILL_1}>
          <ellipse cx={30} cy={70} rx={120} ry={60} />
          <ellipse cx={120} cy={98} rx={90} ry={45} />
          <ellipse cx={CARD_W - 24} cy={64} rx={120} ry={60} />
          <ellipse cx={CARD_W - 118} cy={92} rx={85} ry={42} />
        </g>
        <g transform={`translate(0 ${cardH - 630}) scale(${CARD_W / 1200} 1)`}>
          <path
            d="M0 630 L0 590 Q90 548 190 586 L300 560 L410 594 Q560 556 700 590 L820 556 L940 592 Q1060 552 1200 584 L1200 630Z"
            fill={HILL_1}
          />
          <path
            d="M0 630 L0 610 Q160 586 320 612 Q520 588 700 614 Q900 588 1080 610 L1200 604 L1200 630Z"
            fill={HILL_2}
          />
        </g>

        <Sparkle x={CARD_W / 2 - half - 36} y={86} s={17} />
        <Sparkle x={CARD_W / 2 - half - 13} y={112} s={7} />
        <Sparkle x={CARD_W / 2 + half + 36} y={84} s={17} />
        <Sparkle x={CARD_W / 2 + half + 13} y={110} s={7} />
        <text
          x={CARD_W / 2}
          y={106}
          textAnchor="middle"
          fontSize={titleSize}
          fontWeight={800}
          fill={INK}
          fontFamily={FONT}
        >
          {title}
        </text>

        {/* the headline numbers, side by side with rules between */}
        {stats.map((s, i) => {
          const cx = statsX + (i + 0.5) * STAT_W
          return (
            <g key={s.label}>
              {i > 0 && (
                <line
                  x1={statsX + i * STAT_W}
                  y1={160}
                  x2={statsX + i * STAT_W}
                  y2={244}
                  stroke={STROKE}
                  strokeWidth={2}
                />
              )}
              <text x={cx} y={212} textAnchor="middle" fontSize={64} fontWeight={800} fill={PURPLE} fontFamily={FONT}>
                {s.value}
              </text>
              <text x={cx} y={244} textAnchor="middle" fontSize={21} fontWeight={600} fill={MUTED} fontFamily={FONT}>
                {s.label}
              </text>
            </g>
          )
        })}

        {cols.map((c, i) => (
          <Column key={c.persona.id} col={c} x={PAD + i * (COL_W + GAP)} h={colH} />
        ))}

        {/* the mark, small, bottom right */}
        <image href={merlinUrl} x={CARD_W - PAD - 158} y={cardH - 62} width={42} height={39} />
        <text
          x={CARD_W - PAD}
          y={cardH - 32}
          textAnchor="end"
          fontSize={20}
          fontWeight={700}
          fill={MUTED}
          fontFamily={FONT}
        >
          merlin<tspan fill={PURPLE}>.dev</tspan>
        </text>
      </svg>
    )
  },
)
