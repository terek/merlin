/**
 * Client-side pairing: enter code, call relay /pair/join, exchange keys with daemon.
 */

import { deriveSharedKey, exportAesKey } from '../crypto/keys.ts'
import { loadOrGenerateKeypair, savePairing } from './storage.ts'

export interface JoinResult {
  sessionToken: string
  sharedKey: CryptoKey
  relayUrl: string
  daemonName?: string
}

/**
 * Join a pairing session: call relay /pair/join/:code, exchange keys, return shared key.
 */
export async function joinPairing(
  relayHttpUrl: string,
  code: string,
  name: string,
  baseDir?: string,
): Promise<JoinResult> {
  const kp = await loadOrGenerateKeypair(name, baseDir)

  // Step 1: Join with code
  const joinRes = await fetch(`${relayHttpUrl}/pair/join/${code}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientPubKey: kp.publicKeySpki }),
  })

  if (!joinRes.ok) {
    const body = (await joinRes.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `Failed to join: ${joinRes.status}`)
  }

  const { sessionToken, daemonPubKey, daemonName } = (await joinRes.json()) as {
    sessionToken: string
    daemonPubKey: string
    daemonName?: string
  }

  // Step 2: Derive shared key from daemon's public key
  const sharedKey = await deriveSharedKey(kp.privateKey, daemonPubKey)
  const sharedKeyExported = await exportAesKey(sharedKey)

  // Step 3: Connect to relay and send key exchange
  const wsUrl = relayHttpUrl.replace(/^http/, 'ws')
  const ws = new WebSocket(`${wsUrl}/ws?side=client&token=${encodeURIComponent(sessionToken)}`)

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Key exchange timeout')), 10_000)

    ws.onopen = () => {
      // Send our public key so daemon can derive the same shared key
      ws.send(JSON.stringify({ type: 'key_exchange', publicKey: kp.publicKeySpki }))
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string)
        if (msg.type === 'key_exchange_ack') {
          clearTimeout(timeout)
          ws.close()
          resolve()
        }
      } catch {
        /* ignore */
      }
    }

    ws.onerror = () => {
      clearTimeout(timeout)
      reject(new Error('WebSocket error during key exchange'))
    }
  })

  // Step 4: Persist pairing state
  await savePairing(
    name,
    {
      sessionToken,
      sharedKey: sharedKeyExported,
      relayUrl: relayHttpUrl,
      daemonName,
    },
    baseDir,
  )

  return { sessionToken, sharedKey, relayUrl: relayHttpUrl, daemonName }
}
