import { describe, expect, test } from 'bun:test'
import { ModelStore } from '../../src/discovery/store.ts'

function makeStore(): ModelStore {
  return new ModelStore('test-host', 'test-instance', '0.1.0')
}

describe('ModelStore — initialization', () => {
  test('initial model has correct host info', () => {
    const store = makeStore()
    const model = store.getModel()
    expect(model.host.name).toBe('test-host')
    expect(model.host.instanceName).toBe('test-instance')
    expect(model.host.version).toBe('0.1.0')
    expect(model.host.connectedClients).toBe(0)
    expect(Object.keys(model.projects)).toHaveLength(0)
  })
})

describe('ModelStore — project mutations', () => {
  test('upsertProject creates a new project', () => {
    const store = makeStore()
    store.upsertProject('/home/user/project', {
      displayName: 'project',
      lastTimestamp: 1000,
    })
    const project = store.getModel().projects['/home/user/project']
    expect(project).toBeDefined()
    expect(project.displayName).toBe('project')
    expect(project.lastTimestamp).toBe(1000)
    expect(project.owner).toBe('available')
  })

  test('upsertProject updates existing project', () => {
    const store = makeStore()
    store.upsertProject('/tmp/p', { displayName: 'old' })
    store.upsertProject('/tmp/p', { displayName: 'new' })
    expect(store.getModel().projects['/tmp/p'].displayName).toBe('new')
  })

  test('removeProject deletes it', () => {
    const store = makeStore()
    store.upsertProject('/tmp/p', {})
    store.removeProject('/tmp/p')
    expect(store.getModel().projects['/tmp/p']).toBeUndefined()
  })

  test('setProjectOwner updates owner', () => {
    const store = makeStore()
    store.upsertProject('/tmp/p', {})
    store.setProjectOwner('/tmp/p', { type: 'daemon', instanceName: 'test' })
    expect(store.getModel().projects['/tmp/p'].owner).toEqual({ type: 'daemon', instanceName: 'test' })
  })

  test('setProjectSessions updates sessions', () => {
    const store = makeStore()
    store.upsertProject('/tmp/p', {})
    store.setProjectSessions('/tmp/p', [
      { sessionId: 's1', lastTimestamp: 1000, sizeBytes: 100, userTurnCount: 5, subagentCount: 0 },
    ])
    expect(store.getModel().projects['/tmp/p'].sessions).toHaveLength(1)
    expect(store.getModel().projects['/tmp/p'].sessions[0].sessionId).toBe('s1')
  })

  test('replaceProjects replaces all', () => {
    const store = makeStore()
    store.upsertProject('/tmp/old', {})
    store.replaceProjects({
      '/tmp/new': {
        cwd: '/tmp/new',
        displayName: 'new',
        lastTimestamp: 0,
        sessions: [],
        owner: 'available',
      },
    })
    expect(store.getModel().projects['/tmp/old']).toBeUndefined()
    expect(store.getModel().projects['/tmp/new']).toBeDefined()
  })
})

describe('ModelStore — active session mutations', () => {
  test('createActiveSession returns session with correct defaults', () => {
    const store = makeStore()
    const session = store.createActiveSession('s1', '/tmp/p')
    expect(session.id).toBe('s1')
    expect(session.projectCwd).toBe('/tmp/p')
    expect(session.state).toBe('starting')
    expect(session.contextLines).toEqual([])
    expect(session.pendingApproval).toBeNull()
    expect(session.pendingQuestion).toBeNull()
  })

  test('getActiveSession returns the session', () => {
    const store = makeStore()
    store.createActiveSession('s1', '/tmp')
    expect(store.getActiveSession('s1')).toBeDefined()
    expect(store.getActiveSession('s1')!.id).toBe('s1')
  })

  test('setSessionState updates state', () => {
    const store = makeStore()
    store.createActiveSession('s1', '/tmp')
    store.setSessionState('s1', 'idle')
    expect(store.getActiveSession('s1')!.state).toBe('idle')
  })

  test('pushContextLine adds a line', () => {
    const store = makeStore()
    store.createActiveSession('s1', '/tmp')
    store.pushContextLine('s1', '[assistant] hello')
    expect(store.getActiveSession('s1')!.contextLines).toEqual(['[assistant] hello'])
  })

  test('pushContextLine trims at 2000', () => {
    const store = makeStore()
    store.createActiveSession('s1', '/tmp')
    for (let i = 0; i < 2010; i++) {
      store.pushContextLine('s1', `line ${i}`)
    }
    expect(store.getActiveSession('s1')!.contextLines.length).toBe(2000)
    expect(store.getActiveSession('s1')!.contextLines[0]).toBe('line 10')
  })

  test('removeActiveSession removes it', () => {
    const store = makeStore()
    store.createActiveSession('s1', '/tmp')
    store.removeActiveSession('s1')
    expect(store.getActiveSession('s1')).toBeUndefined()
  })
})

describe('ModelStore — listeners', () => {
  test('model listener fires on upsertProject', () => {
    const store = makeStore()
    let called = false
    store.onModelChange(() => {
      called = true
    })
    store.upsertProject('/tmp/p', {})
    expect(called).toBe(true)
  })

  test('session listener fires on setSessionState', () => {
    const store = makeStore()
    store.createActiveSession('s1', '/tmp')
    let calledWith: string | null = null
    store.onSessionChange((id) => {
      calledWith = id
    })
    store.setSessionState('s1', 'busy')
    expect(calledWith).toBe('s1')
  })

  test('unsubscribe removes listener', () => {
    const store = makeStore()
    let count = 0
    const unsub = store.onModelChange(() => {
      count++
    })
    store.upsertProject('/tmp/p1', {})
    expect(count).toBe(1)
    unsub()
    store.upsertProject('/tmp/p2', {})
    expect(count).toBe(1)
  })

  test('setSessionState with same state does not notify', () => {
    const store = makeStore()
    store.createActiveSession('s1', '/tmp')
    store.setSessionState('s1', 'idle')
    let count = 0
    store.onSessionChange(() => {
      count++
    })
    store.setSessionState('s1', 'idle')
    expect(count).toBe(0)
  })
})
