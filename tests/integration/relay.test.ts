import { afterEach, describe, expect, test } from 'bun:test'
import { createRelay } from '@merlin/relay'
import type { Server } from 'bun'

let server: Server | null = null

afterEach(() => {
  server?.stop(true)
  server = null
})

function startRelay(): { url: string; server: Server } {
  server = createRelay(0)
  const url = `http://localhost:${server.port}`
  return { url, server }
}

function wsUrl(baseUrl: string, side: string, token: string): string {
  return `${baseUrl.replace('http', 'ws')}/ws?side=${side}&token=${encodeURIComponent(token)}`
}

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('WebSocket error'))
  })
}

function waitForMessage(ws: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for message')), timeoutMs)
    ws.onmessage = (event) => {
      clearTimeout(timer)
      resolve(event.data as string)
    }
  })
}

describe('Relay — health check', () => {
  test('GET /health returns ok', async () => {
    const { url } = startRelay()
    const res = await fetch(`${url}/health`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})

describe('Relay — WebSocket upgrade', () => {
  test('rejects missing side/token', async () => {
    const { url } = startRelay()
    const res = await fetch(`${url}/ws`)
    expect(res.status).toBe(400)
  })

  test('rejects invalid side', async () => {
    const { url } = startRelay()
    const res = await fetch(`${url}/ws?side=invalid&token=abc`)
    expect(res.status).toBe(400)
  })
})

describe('Relay — message routing', () => {
  test('daemon message reaches client', async () => {
    const { url } = startRelay()
    const token = 'test-token-1'

    const daemon = await connectWs(wsUrl(url, 'daemon', token))
    const client = await connectWs(wsUrl(url, 'client', token))

    await new Promise((r) => setTimeout(r, 50))

    const messagePromise = waitForMessage(client)
    daemon.send(JSON.stringify({ type: 'snapshot', scope: 'metadata' }))

    const msg = await messagePromise
    expect(JSON.parse(msg).type).toBe('snapshot')

    daemon.close()
    client.close()
  })

  test('client message reaches daemon', async () => {
    const { url } = startRelay()
    const token = 'test-token-2'

    const daemon = await connectWs(wsUrl(url, 'daemon', token))
    const client = await connectWs(wsUrl(url, 'client', token))

    await new Promise((r) => setTimeout(r, 50))

    const messagePromise = waitForMessage(daemon)
    client.send(JSON.stringify({ type: 'subscribe', scope: 'metadata' }))

    const msg = await messagePromise
    expect(JSON.parse(msg).type).toBe('subscribe')

    daemon.close()
    client.close()
  })

  test('new client replaces old client', async () => {
    const { url } = startRelay()
    const token = 'test-token-3'

    const daemon = await connectWs(wsUrl(url, 'daemon', token))
    const c1 = await connectWs(wsUrl(url, 'client', token))

    await new Promise((r) => setTimeout(r, 50))

    // Second client connects — should replace the first
    const c2 = await connectWs(wsUrl(url, 'client', token))

    await new Promise((r) => setTimeout(r, 50))

    const p2 = waitForMessage(c2)
    daemon.send('hello')

    const m2 = await p2
    expect(m2).toBe('hello')

    daemon.close()
    c1.close()
    c2.close()
  })

  test('different tokens are isolated', async () => {
    const { url } = startRelay()

    const daemon1 = await connectWs(wsUrl(url, 'daemon', 'token-a'))
    const client1 = await connectWs(wsUrl(url, 'client', 'token-a'))
    const client2 = await connectWs(wsUrl(url, 'client', 'token-b'))

    await new Promise((r) => setTimeout(r, 50))

    let c2Received = false
    client2.onmessage = () => {
      c2Received = true
    }

    const p1 = waitForMessage(client1)
    daemon1.send('for-token-a')

    const m1 = await p1
    expect(m1).toBe('for-token-a')

    await new Promise((r) => setTimeout(r, 100))
    expect(c2Received).toBe(false)

    daemon1.close()
    client1.close()
    client2.close()
  })
})

describe('Relay — message queuing', () => {
  test('messages queued when client offline, delivered on connect', async () => {
    const { url } = startRelay()
    const token = 'test-queue-1'

    const daemon = await connectWs(wsUrl(url, 'daemon', token))
    await new Promise((r) => setTimeout(r, 50))

    daemon.send('queued-msg')

    const client = await connectWs(wsUrl(url, 'client', token))
    const msg = await waitForMessage(client)
    expect(msg).toBe('queued-msg')

    daemon.close()
    client.close()
  })

  test('messages queued when daemon offline, delivered on connect', async () => {
    const { url } = startRelay()
    const token = 'test-queue-2'

    const client = await connectWs(wsUrl(url, 'client', token))
    await new Promise((r) => setTimeout(r, 50))

    client.send('queued-for-daemon')

    const daemon = await connectWs(wsUrl(url, 'daemon', token))
    const msg = await waitForMessage(daemon)
    expect(msg).toBe('queued-for-daemon')

    daemon.close()
    client.close()
  })
})
