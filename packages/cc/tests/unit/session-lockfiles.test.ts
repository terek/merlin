import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { SessionLockfileReader } from '../../src/session-lockfiles.ts'

let tempDir: string

beforeEach(() => {
  tempDir = `/tmp/merlin-test-lockfiles-${Date.now()}-${Math.random().toString(36).slice(2)}`
  mkdirSync(tempDir, { recursive: true })
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function writeLock(pid: number, data: { sessionId: string; cwd: string; startedAt: number }) {
  writeFileSync(path.join(tempDir, `${pid}.json`), JSON.stringify(data))
}

describe('SessionLockfileReader', () => {
  test('returns empty for nonexistent dir', async () => {
    const reader = new SessionLockfileReader('/nonexistent')
    expect(await reader.readAll()).toEqual([])
  })

  test('returns empty for empty dir', async () => {
    const reader = new SessionLockfileReader(tempDir)
    expect(await reader.readAll()).toEqual([])
  })

  test('reads lockfile for alive process', async () => {
    // Use our own PID — guaranteed alive
    writeLock(process.pid, { sessionId: 'abc-123', cwd: '/home/user/proj', startedAt: 1000 })

    const reader = new SessionLockfileReader(tempDir)
    const locks = await reader.readAll()
    expect(locks).toHaveLength(1)
    expect(locks[0].pid).toBe(process.pid)
    expect(locks[0].sessionId).toBe('abc-123')
    expect(locks[0].cwd).toBe('/home/user/proj')
  })

  test('removes lockfile for dead process', async () => {
    writeLock(999999, { sessionId: 'dead-session', cwd: '/tmp', startedAt: 1000 })

    const reader = new SessionLockfileReader(tempDir)
    const locks = await reader.readAll()
    expect(locks).toHaveLength(0)

    // File should be cleaned up
    await Bun.sleep(50)
    const exists = await Bun.file(path.join(tempDir, '999999.json')).exists()
    expect(exists).toBe(false)
  })

  test('removes corrupt lockfile', async () => {
    // Use a valid PID filename but corrupt content
    writeFileSync(path.join(tempDir, `${process.pid}.json`), 'not-json')

    const reader = new SessionLockfileReader(tempDir)
    const locks = await reader.readAll()
    expect(locks).toHaveLength(0)

    await Bun.sleep(50)
    const exists = await Bun.file(path.join(tempDir, `${process.pid}.json`)).exists()
    expect(exists).toBe(false)
  })

  test('ignores non-json files', async () => {
    writeFileSync(path.join(tempDir, 'readme.txt'), 'hello')
    writeLock(process.pid, { sessionId: 'real-session', cwd: '/proj', startedAt: 1000 })

    const reader = new SessionLockfileReader(tempDir)
    const locks = await reader.readAll()
    expect(locks).toHaveLength(1)
    expect(locks[0].sessionId).toBe('real-session')
  })

  test('ignores files with non-numeric names', async () => {
    writeFileSync(path.join(tempDir, 'not-a-pid.json'), JSON.stringify({ sessionId: 'x', cwd: '/', startedAt: 0 }))
    writeLock(process.pid, { sessionId: 'real', cwd: '/proj', startedAt: 1000 })

    const reader = new SessionLockfileReader(tempDir)
    const locks = await reader.readAll()
    expect(locks).toHaveLength(1)
    expect(locks[0].sessionId).toBe('real')
  })

  test('byCwd groups locks by working directory', async () => {
    writeLock(process.pid, { sessionId: 'session-a', cwd: '/proj-1', startedAt: 1000 })
    writeLock(process.ppid, { sessionId: 'session-b', cwd: '/proj-2', startedAt: 2000 })

    const reader = new SessionLockfileReader(tempDir)
    const map = await reader.byCwd()
    expect(map.size).toBe(2)
    expect(map.get('/proj-1')).toHaveLength(1)
    expect(map.get('/proj-2')).toHaveLength(1)
  })

  test('multiple alive sessions coexist', async () => {
    writeLock(process.pid, { sessionId: 's1', cwd: '/proj', startedAt: 1000 })
    writeLock(process.ppid, { sessionId: 's2', cwd: '/proj', startedAt: 2000 })

    const reader = new SessionLockfileReader(tempDir)
    const locks = await reader.readAll()
    expect(locks).toHaveLength(2)
    const ids = locks.map((l) => l.sessionId).sort()
    expect(ids).toEqual(['s1', 's2'])
  })
})
