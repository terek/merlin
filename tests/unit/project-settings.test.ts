import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { WorkspaceStore } from '../../src/discovery/workspace.ts'

const tempDir = path.join(import.meta.dir, `.project-settings-test-${Date.now()}`)

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('WorkspaceStore — archive', () => {
  test('starts empty', async () => {
    const store = new WorkspaceStore(tempDir)
    expect(await store.archivedProjectCwds()).toEqual(new Set())
    expect(await store.archivedSessionIds()).toEqual(new Set())
  })

  test('archives and unarchives projects', async () => {
    const store = new WorkspaceStore(tempDir)
    await store.archive('project', '/tmp/proj1')
    expect((await store.archivedProjectCwds()).has('/tmp/proj1')).toBe(true)
    expect((await store.archivedProjectCwds()).has('/tmp/proj2')).toBe(false)

    await store.unarchive('project', '/tmp/proj1')
    expect((await store.archivedProjectCwds()).has('/tmp/proj1')).toBe(false)
  })

  test('archives and unarchives sessions', async () => {
    const store = new WorkspaceStore(tempDir)
    await store.archive('session', 'sess-1')
    await store.archive('session', 'sess-2')
    expect((await store.archivedSessionIds()).has('sess-1')).toBe(true)
    expect((await store.archivedSessionIds()).has('sess-2')).toBe(true)

    await store.unarchive('session', 'sess-1')
    expect((await store.archivedSessionIds()).has('sess-1')).toBe(false)
    expect((await store.archivedSessionIds()).has('sess-2')).toBe(true)
  })

  test('deduplicates archive calls', async () => {
    const store = new WorkspaceStore(tempDir)
    await store.archive('project', '/dup')
    await store.archive('project', '/dup')
    await store.archive('project', '/dup')
    expect((await store.archivedProjectCwds()).size).toBe(1)
  })

  test('persists to disk and reloads', async () => {
    const dir = path.join(tempDir, 'persist')
    const store1 = new WorkspaceStore(dir)
    await store1.archive('project', '/persistent')

    const store2 = new WorkspaceStore(dir)
    expect((await store2.archivedProjectCwds()).has('/persistent')).toBe(true)
  })
})

describe('WorkspaceStore — collapse', () => {
  test('starts with no collapsed projects', async () => {
    const dir = path.join(tempDir, 'collapse')
    const store = new WorkspaceStore(dir)
    expect(await store.collapsedCwds()).toEqual(new Set())
  })

  test('collapses and uncollapses', async () => {
    const dir = path.join(tempDir, 'collapse')
    const store = new WorkspaceStore(dir)
    await store.collapse('/work/myapp')
    expect((await store.collapsedCwds()).has('/work/myapp')).toBe(true)

    await store.uncollapse('/work/myapp')
    expect((await store.collapsedCwds()).has('/work/myapp')).toBe(false)
  })

  test('deduplicates collapse calls', async () => {
    const dir = path.join(tempDir, 'collapse-dedup')
    const store = new WorkspaceStore(dir)
    await store.collapse('/dup')
    await store.collapse('/dup')
    expect((await store.collapsedCwds()).size).toBe(1)
  })

  test('collapse persists to disk', async () => {
    const dir = path.join(tempDir, 'collapse-persist')
    const store1 = new WorkspaceStore(dir)
    await store1.collapse('/work/proj')

    const store2 = new WorkspaceStore(dir)
    expect((await store2.collapsedCwds()).has('/work/proj')).toBe(true)
  })
})

describe('WorkspaceStore — legacy migration', () => {
  test('migrates legacy archived.json on first load', async () => {
    const dir = path.join(tempDir, 'legacy')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })

    // Write legacy format
    writeFileSync(
      path.join(dir, 'archived.json'),
      JSON.stringify({
        entries: [
          { id: '/old/proj', type: 'project', archivedAt: 1000 },
          { id: 'old-sess', type: 'session', archivedAt: 2000 },
        ],
      }),
    )

    const store = new WorkspaceStore(dir)
    expect((await store.archivedProjectCwds()).has('/old/proj')).toBe(true)
    expect((await store.archivedSessionIds()).has('old-sess')).toBe(true)
    expect(await store.collapsedCwds()).toEqual(new Set())
  })
})
