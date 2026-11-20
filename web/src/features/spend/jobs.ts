// What the spend graph says about background jobs (a command that runs on its own, a monitor): the
// hover line, the frame's label and the turn card's lines. Pure.
import type { Job } from '../../api/types'
import { formatDuration, plural } from '../../lib/format'
import type { JobMark, JobReturnMark } from './timeline'

/** "background command" or "monitor". */
export const jobKind = (j: Pick<JobMark, 'kind'>) => (j.kind === 'monitor' ? 'monitor' : 'background command')

/** "completed, exit 0", "failed, exit 2", "killed", "open". */
export function jobStatus(j: Pick<JobMark, 'status' | 'exitCode'>): string {
  return j.exitCode !== undefined && j.status !== 'open' ? `${j.status}, exit ${j.exitCode}` : j.status
}

/** How one return reached its receiver: "woke turn 2", "delivered to explorer", "fetched in turn 4". */
export function returnText(r: Pick<JobReturnMark, 'how' | 'turn' | 'to'>): string {
  const where = (prep: string) => (r.to ? `${prep} ${r.to}` : r.turn !== undefined ? `in turn ${r.turn}` : '')
  const text =
    r.how === 'woke'
      ? r.to
        ? `woke ${r.to}`
        : r.turn !== undefined
          ? `woke turn ${r.turn}`
          : 'woke'
      : r.how === 'delivered'
        ? `delivered ${where('to')}`
        : `fetched ${where('by')}`
  return text.trim()
}

/** The hover line over a job: its kind, what it was, how long, how it ended and where its output went. */
export function jobLine(j: JobMark): string {
  const parts = [jobKind(j), j.description]
  if (!j.open) parts.push(formatDuration(j.endMs - j.startMs))
  if (j.kind === 'monitor' && j.returns.length > 0) parts.push(plural(j.returns.length, 'event'))
  parts.push(jobStatus(j))
  const shown = j.returns.slice(0, 3).map(returnText)
  if (shown.length > 0) parts.push(shown.join(', ') + (j.returns.length > 3 ? ` and ${j.returns.length - 3} more` : ''))
  return parts.filter(Boolean).join(' · ')
}

/** The label on a job's frame: what it was and how long it ran, cut to `room` px (the description loses its end first). */
export function jobLabel(j: JobMark, room: number, charPx = 5.1): string {
  const max = Math.floor(room / charPx)
  if (max < 4) return ''
  const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1)).trimEnd()}…`)
  const dur = j.open ? '' : formatDuration(j.endMs - j.startMs)
  const full = [j.description, dur].filter(Boolean).join(' · ')
  if (full.length <= max) return full
  // the duration is kept while the description can still be read with it
  if (dur && max - dur.length - 3 >= 8) return `${cut(j.description, max - dur.length - 3)} · ${dur}`
  return cut(j.description, max)
}

/** The jobs a turn started, and those whose output came in or woke it, as the turn card's lines. */
export function turnJobs(jobs: readonly Job[] | undefined, turn: number) {
  const name = (j: Job) => j.description || j.command || j.id
  const done = (j: Job) =>
    j.status === 'open' ? 'still running' : j.exitCode !== undefined ? `${j.status}, exit ${j.exitCode}` : j.status
  return {
    started: (jobs ?? []).filter((j) => j.turn === turn).map(name),
    came: (jobs ?? []).flatMap((j) =>
      (j.returns ?? [])
        .filter((r) => r.turn === turn)
        .map((r) => ({
          key: `${j.id}/${r.at}`,
          text: `${name(j)} — ${r.final ? done(j) : r.how === 'fetched' ? 'output read' : 'output'}`,
          woke: r.how === 'woke',
        })),
    ),
  }
}
