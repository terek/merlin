import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface LockInfo {
  pid: number
  instanceName: string
  startedAt: number
}

const MERLIN_DIR = path.join(os.homedir(), '.merlin')
const LOCK_FILE = path.join(MERLIN_DIR, 'daemon.lock')

export function acquireLock(instanceName: string): boolean {
  mkdirSync(MERLIN_DIR, { recursive: true })

  // Check existing lock
  if (existsSync(LOCK_FILE)) {
    try {
      const existing = JSON.parse(readFileSync(LOCK_FILE, 'utf-8')) as LockInfo
      // Check if the process is still alive
      try {
        process.kill(existing.pid, 0) // signal 0 = check existence
        return false // process still running
      } catch {
        // Process dead — stale lock, proceed
      }
    } catch {
      // Corrupt lock file — proceed
    }
  }

  const info: LockInfo = {
    pid: process.pid,
    instanceName,
    startedAt: Date.now(),
  }
  writeFileSync(LOCK_FILE, JSON.stringify(info, null, 2))
  return true
}

export function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      const existing = JSON.parse(readFileSync(LOCK_FILE, 'utf-8')) as LockInfo
      if (existing.pid === process.pid) {
        unlinkSync(LOCK_FILE)
      }
    }
  } catch {
    // best-effort
  }
}

export function readLock(): LockInfo | null {
  try {
    if (existsSync(LOCK_FILE)) {
      return JSON.parse(readFileSync(LOCK_FILE, 'utf-8')) as LockInfo
    }
  } catch {
    /* ignore */
  }
  return null
}
