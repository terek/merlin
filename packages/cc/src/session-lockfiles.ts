/**
 * Reads session lockfiles written by the Merlin SessionStart hook.
 * Each file: ~/.merlin/sessions/<pid>.json = { sessionId, cwd, startedAt }
 * The PID as filename makes liveness checks trivial without reading the file.
 */
import { readdir, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface SessionLock {
  sessionId: string
  pid: number
  cwd: string
  startedAt: number
}

export class SessionLockfileReader {
  constructor(private lockDir: string = path.join(os.homedir(), '.merlin', 'sessions')) {}

  /** Read all lockfiles, verify PIDs are alive, clean up stale ones. */
  async readAll(): Promise<SessionLock[]> {
    let files: string[]
    try {
      files = await readdir(this.lockDir)
    } catch {
      return []
    }

    const locks: SessionLock[] = []

    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const pid = parseInt(file.slice(0, -5), 10)
      if (Number.isNaN(pid)) continue
      const filePath = path.join(this.lockDir, file)

      if (!isAlive(pid)) {
        // Stale lockfile — process died without SessionEnd cleanup
        unlink(filePath).catch(() => {})
        continue
      }

      try {
        const text = await Bun.file(filePath).text()
        const data = JSON.parse(text) as { sessionId: string; cwd: string; startedAt: number }
        locks.push({ sessionId: data.sessionId, pid, cwd: data.cwd, startedAt: data.startedAt })
      } catch {
        // Corrupt file — remove it
        unlink(filePath).catch(() => {})
      }
    }

    return locks
  }

  /** Get locks grouped by cwd. */
  async byCwd(): Promise<Map<string, SessionLock[]>> {
    const locks = await this.readAll()
    const map = new Map<string, SessionLock[]>()
    for (const lock of locks) {
      const list = map.get(lock.cwd) ?? []
      list.push(lock)
      map.set(lock.cwd, list)
    }
    return map
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
