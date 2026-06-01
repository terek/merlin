/**
 * Daemon-side pairing: create a code via relay, wait for client to join.
 */

import os from 'node:os'
import { deriveSharedKey, exportAesKey } from '../crypto/keys.ts'
import { addPairing, loadOrGenerateKeypair } from './storage.ts'

export interface PairingResult {
  sessionToken: string
  sharedKey: CryptoKey
  relayUrl: string
}

export interface InitiatePairingOptions {
  relayHttpUrl: string
  name: string
  /** Daemon display name sent to the client. Defaults to os.hostname(). */
  daemonName?: string
  /** Called when the pairing code is ready. Use for display (QR, TUI, etc.). */
  onCodeReady?: (code: string, pairingUrl: string, expiresIn: number) => void
  /** Base directory for keypair/pairing storage. Default: ~/.merlin/ */
  baseDir?: string
}

/**
 * Initiate pairing: call relay /pair/create, notify via onCodeReady, wait for client key exchange.
 * Returns the session token and derived shared key once a client joins.
 */
export async function initiatePairing(opts: InitiatePairingOptions): Promise<PairingResult> {
  const { relayHttpUrl, name, baseDir } = opts
  const daemonName = opts.daemonName ?? os.hostname().replace(/\.local$/, '')
  const kp = await loadOrGenerateKeypair(name, baseDir)

  // Step 1: Create pairing session
  const createRes = await fetch(`${relayHttpUrl}/pair/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ daemonPubKey: kp.publicKeySpki, daemonName }),
  })

  if (!createRes.ok) {
    throw new Error(`Failed to create pairing: ${createRes.status} ${await createRes.text()}`)
  }

  const { code, sessionToken, expiresIn } = (await createRes.json()) as {
    code: string
    sessionToken: string
    expiresIn: number
  }

  // Step 2: Notify caller (for display)
  const relayHost = relayHttpUrl.replace(/^https?:\/\//, '')
  const pairingUrl = `merlin://pair?code=${code}&relay=${relayHost}`
  opts.onCodeReady?.(code, pairingUrl, expiresIn)

  // Step 3: Wait for client key exchange on WebSocket
  return new Promise((resolve, reject) => {
    const wsUrl = relayHttpUrl.replace(/^http/, 'ws')
    const ws = new WebSocket(`${wsUrl}/ws?side=daemon&token=${encodeURIComponent(sessionToken)}`)

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data as string)
        if (msg.type === 'key_exchange' && msg.publicKey) {
          const sharedKey = await deriveSharedKey(kp.privateKey, msg.publicKey)
          const sharedKeyExported = await exportAesKey(sharedKey)

          ws.send(JSON.stringify({ type: 'key_exchange_ack' }))
          ws.close()

          // Persist pairing
          await addPairing(
            name,
            {
              sessionToken,
              sharedKey: sharedKeyExported,
              relayUrl: relayHttpUrl,
              daemonName,
            },
            baseDir,
          )

          resolve({ sessionToken, sharedKey, relayUrl: relayHttpUrl })
        }
      } catch {
        /* ignore */
      }
    }

    ws.onerror = () => {
      reject(new Error('WebSocket error during pairing'))
    }
  })
}
