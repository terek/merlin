import { describe, expect, test } from 'bun:test'
import type { DaemonMessage } from '@merlin/protocol'
import { type SyncClient, SyncEngine } from '@merlin/sync'
import { ModelStore } from '../../src/discovery/store.ts'

function makePair() {
  const store = new ModelStore('host', 'instance', '0.1.0')
  const engine = new SyncEngine(store)
  engine.start()
  return { store, engine }
}

function makeClient(id: string): SyncClient & { received: DaemonMessage[] } {
  const received: DaemonMessage[] = []
  return {
    id,
    received,
    sendMessage(msg: string) {
      received.push(JSON.parse(msg))
    },
  }
}

describe('SyncEngine — metadata subscription', () => {
  test('subscribe sends full snapshot', () => {
    const { engine } = makePair()
    const client = makeClient('c1')
    engine.addClient(client)
    engine.subscribeMetadata('c1')

    expect(client.received).toHaveLength(1)
    expect(client.received[0].type).toBe('snapshot')
    expect((client.received[0] as any).scope).toBe('metadata')
    expect((client.received[0] as any).data.host.name).toBe('host')
    engine.stop()
  })

  test('model mutation sends patch', () => {
    const { store, engine } = makePair()
    const client = makeClient('c1')
    engine.addClient(client)
    engine.subscribeMetadata('c1')
    client.received.length = 0 // clear snapshot

    store.upsertProject('/tmp/p', { displayName: 'project' })

    expect(client.received).toHaveLength(1)
    expect(client.received[0].type).toBe('patch')
    expect((client.received[0] as any).scope).toBe('metadata')
    expect((client.received[0] as any).ops.length).toBeGreaterThan(0)
    engine.stop()
  })

  test('unsubscribed client does not receive patches', () => {
    const { store, engine } = makePair()
    const client = makeClient('c1')
    engine.addClient(client)
    // Never subscribe to metadata
    store.upsertProject('/tmp/p', {})
    expect(client.received).toHaveLength(0)
    engine.stop()
  })

  test('unsubscribe stops patches', () => {
    const { store, engine } = makePair()
    const client = makeClient('c1')
    engine.addClient(client)
    engine.subscribeMetadata('c1')
    client.received.length = 0

    engine.unsubscribeMetadata('c1')
    store.upsertProject('/tmp/p', {})
    expect(client.received).toHaveLength(0)
    engine.stop()
  })

  test('no patch if model unchanged', () => {
    const { store, engine } = makePair()
    const client = makeClient('c1')
    engine.addClient(client)
    engine.subscribeMetadata('c1')
    client.received.length = 0

    // Trigger a real model change, then verify no spurious patches
    store.upsertProject('/tmp/test', { displayName: 'test' })
    expect(client.received).toHaveLength(1)
    client.received.length = 0
    // No further changes → no patches
    expect(client.received).toHaveLength(0)
    engine.stop()
  })
})

describe('SyncEngine — session subscription', () => {
  test('subscribe sends session snapshot', () => {
    const { store, engine } = makePair()
    store.createActiveSession('s1', '/tmp')
    const client = makeClient('c1')
    engine.addClient(client)
    engine.subscribeSession('c1', 's1')

    expect(client.received).toHaveLength(1)
    expect(client.received[0].type).toBe('snapshot')
    expect((client.received[0] as any).scope).toBe('session')
    expect((client.received[0] as any).sessionId).toBe('s1')
    engine.stop()
  })

  test('subscribe to nonexistent session sends error', () => {
    const { engine } = makePair()
    const client = makeClient('c1')
    engine.addClient(client)
    engine.subscribeSession('c1', 'nonexistent')

    expect(client.received).toHaveLength(1)
    expect(client.received[0].type).toBe('error')
    engine.stop()
  })

  test('session mutation sends patch after flush', () => {
    const { store, engine } = makePair()
    store.createActiveSession('s1', '/tmp')
    const client = makeClient('c1')
    engine.addClient(client)
    engine.subscribeSession('c1', 's1')
    client.received.length = 0

    store.setSessionState('s1', 'busy')
    engine.flush()

    expect(client.received.length).toBeGreaterThanOrEqual(1)
    const patch = client.received.find((m) => m.type === 'patch')
    expect(patch).toBeDefined()
    expect((patch as any).scope).toBe('session')
    engine.stop()
  })

  test('only subscribed clients get session patches', () => {
    const { store, engine } = makePair()
    store.createActiveSession('s1', '/tmp')
    const c1 = makeClient('c1')
    const c2 = makeClient('c2')
    engine.addClient(c1)
    engine.addClient(c2)
    engine.subscribeSession('c1', 's1')
    c1.received.length = 0

    store.setSessionState('s1', 'busy')
    engine.flush()

    expect(c1.received.length).toBeGreaterThan(0)
    expect(c2.received).toHaveLength(0)
    engine.stop()
  })
})

describe('SyncEngine — multi-client', () => {
  test('multiple clients get same metadata snapshot', () => {
    const { engine } = makePair()
    const c1 = makeClient('c1')
    const c2 = makeClient('c2')
    engine.addClient(c1)
    engine.addClient(c2)
    engine.subscribeMetadata('c1')
    engine.subscribeMetadata('c2')

    expect(c1.received).toHaveLength(1)
    expect(c2.received).toHaveLength(1)
    expect((c1.received[0] as any).data).toEqual((c2.received[0] as any).data)
    engine.stop()
  })

  test('removed client does not receive patches', () => {
    const { store, engine } = makePair()
    const client = makeClient('c1')
    engine.addClient(client)
    engine.subscribeMetadata('c1')
    client.received.length = 0

    engine.removeClient('c1')
    store.upsertProject('/tmp/p', {})
    expect(client.received).toHaveLength(0)
    engine.stop()
  })
})

describe('SyncEngine — reconnection (CRITICAL)', () => {
  test('reconnecting client gets full snapshot', () => {
    const { store, engine } = makePair()

    // First connection
    const c1 = makeClient('c1')
    engine.addClient(c1)
    engine.subscribeMetadata('c1')
    expect(c1.received).toHaveLength(1)

    // Mutate model
    store.upsertProject('/tmp/p', { displayName: 'project' })

    // Disconnect
    engine.removeClient('c1')

    // Reconnect (new client instance with same id)
    const c1b = makeClient('c1')
    engine.addClient(c1b)
    engine.subscribeMetadata('c1')

    // Should get a full snapshot with the updated model
    expect(c1b.received).toHaveLength(1)
    expect(c1b.received[0].type).toBe('snapshot')
    expect((c1b.received[0] as any).data.projects['/tmp/p']).toBeDefined()
    engine.stop()
  })

  test('reconnecting session subscriber gets full snapshot', () => {
    const { store, engine } = makePair()
    store.createActiveSession('s1', '/tmp')
    store.setSessionState('s1', 'busy')

    const c1 = makeClient('c1')
    engine.addClient(c1)
    engine.subscribeSession('c1', 's1')
    engine.removeClient('c1')

    const c1b = makeClient('c1')
    engine.addClient(c1b)
    engine.subscribeSession('c1', 's1')

    expect(c1b.received).toHaveLength(1)
    expect(c1b.received[0].type).toBe('snapshot')
    expect((c1b.received[0] as any).data.state).toBe('busy')
    engine.stop()
  })
})
