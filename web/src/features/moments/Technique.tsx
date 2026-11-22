// A technique under an open row: the reason, the estimate, the fix to copy (worded for a harness) and the follow-up.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { MomentHit, MomentTechnique } from '../../api/types'
import { cn } from '../../lib/cn'
import { sessionPath } from '../../lib/paths'
import { parseTime, shortDate } from '../../lib/time'
import { CopyButton } from '../../ui/controls'
import { HarnessIcon } from '../../ui/harness'
import { defaultChoice, fixChoices, fixWording, UNIVERSAL } from './layout'

const CHOICE_KEY = 'merlin.moments.fixVariant'

function readChoice(): string | null {
  try {
    return localStorage.getItem(CHOICE_KEY)
  } catch {
    return null
  }
}

function writeChoice(c: string) {
  try {
    localStorage.setItem(CHOICE_KEY, c)
  } catch {
    // private window or blocked storage: the choice lasts until the page is closed
  }
}

/** "≈ $1,200 / month". */
function monthly(usd: number): string {
  return `≈ $${Math.round(usd).toLocaleString('en-US')} / month`
}

function hitPath(h: MomentHit): string {
  return sessionPath(h.session, h.turn !== undefined ? `t${h.turn}` : undefined)
}

/** The radios in the copy box's header: Universal, and a harness's own wording with its logo. */
function ChoiceToggle({
  choices,
  value,
  onChange,
}: {
  choices: string[]
  value: string
  onChange: (c: string) => void
}) {
  return (
    <fieldset aria-label="Wording" className="m-0 flex items-center gap-0.5 border-0 p-0">
      {choices.map((c) => (
        <label
          key={c}
          title={c === UNIVERSAL ? 'Universal: any harness' : undefined}
          className={cn(
            'inline-flex h-5 cursor-pointer items-center gap-1 rounded px-1.5 text-meta has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-accent',
            value === c ? 'text-fg' : 'text-faint hover:text-fg',
          )}
          style={value === c ? { background: 'var(--chip-sel)' } : undefined}
        >
          <input
            type="radio"
            name="fix-wording"
            className="sr-only"
            checked={value === c}
            onChange={() => onChange(c)}
          />
          {c === UNIVERSAL ? 'Universal' : <HarnessIcon harness={c} size={12} />}
        </label>
      ))}
    </fieldset>
  )
}

export function TechniqueSection({
  t,
  now,
  usual,
  onCopy,
}: {
  t: MomentTechnique
  now: Date
  /** The harness the person mostly uses: the wording that opens first. */
  usual?: string
  onCopy?: () => void
}) {
  const e = t.engaged
  const copied = parseTime(e?.copiedAt)
  const choices = fixChoices(t.fix)
  const [saved, setSaved] = useState(readChoice)
  const choice = defaultChoice(t.fix, usual, saved)
  const w = fixWording(t.fix, choice)
  return (
    <div className="space-y-1.5 pt-1" data-testid="technique">
      <p className="max-w-[80ch]">{t.reason}</p>
      {t.estimate && (
        <div className="max-w-[80ch]">
          <p>
            <span className="font-medium text-bad tabular-nums">{monthly(t.estimate.monthlyUSD)}</span>{' '}
            <span className="text-faint">estimated saving</span>
          </p>
          <p className="text-faint">{w.how ?? t.estimate.how}</p>
        </div>
      )}
      <div className="w-[72ch] max-w-full rounded border border-line bg-surface-2">
        <div className="flex items-center justify-between gap-2 border-line border-b py-0.5 pr-1 pl-2.5">
          <span className="text-faint text-meta">
            {t.fix.kind === 'shell' ? 'Run in a terminal' : 'Add to AGENTS.md'}
          </span>
          <div className="flex items-center gap-2">
            {choices.length > 0 && (
              <ChoiceToggle
                choices={choices}
                value={choice}
                onChange={(c) => {
                  writeChoice(c)
                  setSaved(c)
                }}
              />
            )}
            <CopyButton text={w.text} onCopy={onCopy}>
              Copy
            </CopyButton>
          </div>
        </div>
        <pre className="m-0 whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-meta text-fg">{w.text}</pre>
      </div>
      {t.fix.link && (
        <p>
          <a href={t.fix.link} target="_blank" rel="noreferrer">
            {t.fix.link.replace(/^https:\/\//, '')} ↗
          </a>
        </p>
      )}
      {e?.watching && (
        <p className="max-w-[80ch]">
          {e.followUp ?? `Copied ${copied ? shortDate(copied, now) : ''} · watching your next sessions`}
        </p>
      )}
      {t.example && (
        <p>
          <Link to={hitPath(t.example)}>See it in your sessions →</Link>
        </p>
      )}
    </div>
  )
}
