#!/usr/bin/env bun
/**
 * MockCC: a script that speaks CC's NDJSON protocol.
 * Used in integration tests that need a real subprocess.
 *
 * Reads NDJSON from stdin, writes NDJSON to stdout.
 * Behavior is controlled by the MOCK_CC_SCRIPT env var (JSON array of events to emit).
 */

const scriptJson = process.env.MOCK_CC_SCRIPT
const events: Array<Record<string, unknown>> = scriptJson ? JSON.parse(scriptJson) : []

// Emit scripted events on startup (after a small delay to let the read loop start)
setTimeout(async () => {
  for (const event of events) {
    const delay = (event._delay as number) ?? 0
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    const { _delay, ...clean } = event
    process.stdout.write(`${JSON.stringify(clean)}\n`)
  }
}, 50)

// Read stdin and echo user turns back as assistant responses + result
const decoder = new TextDecoder()
const reader = (Bun.stdin.stream() as ReadableStream<Uint8Array>).getReader()
let partial = ''

async function readLoop() {
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      partial += decoder.decode(value)
      const lines = partial.split('\n')
      partial = lines.pop()!
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'user') {
            // Echo back as assistant text + result
            const text =
              typeof msg.message?.content === 'string' ? msg.message.content : (msg.message?.content?.[0]?.text ?? 'ok')
            process.stdout.write(
              `${JSON.stringify({
                type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'text', text: `Echo: ${text}` }] },
              })}\n`,
            )
            process.stdout.write(
              `${JSON.stringify({
                type: 'result',
                subtype: 'success',
                session_id: 'mock-session-001',
              })}\n`,
            )
          } else if (msg.type === 'control_response') {
            // After control response, send a result
            process.stdout.write(
              `${JSON.stringify({
                type: 'result',
                subtype: 'success',
                session_id: 'mock-session-001',
              })}\n`,
            )
          }
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* stdin closed */
  }
}

readLoop()
