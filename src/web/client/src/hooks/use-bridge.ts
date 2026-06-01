import { useEffect, useRef } from 'react'
import { useMerlinStore } from '@/stores/merlin-store'
import type { ClientMessage, DaemonMessage } from '@/types/protocol'

/** Connect to the bridge WebSocket and pipe messages into the store. */
export function useBridge() {
  const wsRef = useRef<WebSocket | null>(null)
  const handleMessage = useMerlinStore((s) => s.handleMessage)
  const setConnected = useMerlinStore((s) => s.setConnected)
  const setSend = useMerlinStore((s) => s.setSend)

  useEffect(() => {
    let disposed = false
    let reconnectTimer: ReturnType<typeof setTimeout>

    function connect() {
      if (disposed) return

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${location.host}/bridge`)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        // Subscribe to metadata on connect
        ws.send(JSON.stringify({ type: 'subscribe', scope: 'metadata' }))
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as DaemonMessage
          handleMessage(msg)
        } catch (e) {
          console.warn('[bridge] Failed to parse message:', e, event.data?.slice?.(0, 200))
        }
      }

      ws.onclose = () => {
        setConnected(false)
        // Only clear ref if this is still the active WebSocket
        // (avoids StrictMode race: old WS onclose clobbering new WS)
        if (wsRef.current === ws) {
          wsRef.current = null
        }
        if (!disposed) {
          reconnectTimer = setTimeout(connect, 2000)
        }
      }

      ws.onerror = () => {}
    }

    // Set the send function on the store
    setSend((msg: ClientMessage) => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg))
      }
    })

    connect()

    return () => {
      disposed = true
      clearTimeout(reconnectTimer)
      wsRef.current?.close()
    }
  }, [handleMessage, setConnected, setSend])
}
