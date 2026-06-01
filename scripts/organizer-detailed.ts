#!/usr/bin/env bun
/**
 * One-off: build a richer organizer-input JSON. Output shape matches what
 * src/gateway/organizer.ts sends to the LLM: a flat chronological list of
 * tasks with concepts, composite taskIds "<sessionId>/<localTaskId>", and
 * no session metadata.
 *
 * Usage:
 *   bun scripts/organizer-detailed.ts <cwd> [outPath]
 *   bun scripts/organizer-detailed.ts .
 *
 * Default outPath: /tmp/session_organizer_detailed.json
 */

import os from 'node:os'
import path from 'node:path'
import { cwdToProjectDirName, LeanSessionStore } from '@merlin/processor'

const cwdArg = process.argv[2]
if (!cwdArg) {
  console.error('usage: bun scripts/organizer-detailed.ts <cwd> [outPath]')
  process.exit(1)
}
const cwd = path.resolve(cwdArg)
const outPath = process.argv[3] ?? '/tmp/session_organizer_detailed.json'

const merlinDir = path.join(os.homedir(), '.merlin')
const store = new LeanSessionStore(merlinDir, cwdToProjectDirName(cwd))

const sessionIds = await store.listSessionIds()
if (sessionIds.length === 0) {
  console.error(`no processed sessions found for ${cwd}`)
  console.error(`(looked in ${path.join(merlinDir, 'projects', cwdToProjectDirName(cwd))})`)
  process.exit(1)
}

interface FlatTask {
  taskId: string
  description: string
  turnCount: number
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  concepts?: Array<{ concept: string; description: string }>
}

const collected: Array<FlatTask & { _sortKey: number }> = []

for (const sessionId of sessionIds) {
  const session = await store.readSession(sessionId)
  if (!session) continue
  for (const task of session.tasks ?? []) {
    collected.push({
      taskId: `${sessionId}/${task.id}`,
      description: task.description,
      turnCount: task.turns.length,
      startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null,
      endedAt: task.endedAt ? new Date(task.endedAt).toISOString() : null,
      durationMs: task.startedAt && task.endedAt ? task.endedAt - task.startedAt : null,
      concepts: task.concepts?.items.map((c) => ({ concept: c.concept, description: c.description })),
      _sortKey: task.startedAt ?? Number.MAX_SAFE_INTEGER,
    })
  }
}

collected.sort((a, b) => a._sortKey - b._sortKey)
const tasks: FlatTask[] = collected.map(({ _sortKey: _, ...rest }) => rest)

const payload = {
  cwd,
  generatedAt: new Date().toISOString(),
  tasks,
}

await Bun.write(outPath, JSON.stringify(payload, null, 2))

const bytes = Bun.file(outPath).size
const tasksWithConcepts = tasks.filter((t) => t.concepts && t.concepts.length > 0).length
const totalConcepts = tasks.reduce((s, t) => s + (t.concepts?.length ?? 0), 0)

console.log(`wrote ${outPath}`)
console.log(`  ${tasks.length} task(s), chronological`)
console.log(`  ${tasksWithConcepts}/${tasks.length} tasks have concepts — ${totalConcepts} concepts total`)
console.log(`  ${(bytes / 1024).toFixed(1)} KB on disk`)
