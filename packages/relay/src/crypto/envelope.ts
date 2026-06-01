/**
 * AES-256-GCM encrypt/decrypt for relay messages.
 * The relay only sees opaque envelopes -- never plaintext.
 */

import { base64url, fromBase64url } from './keys.ts'

export interface RelayEnvelope {
  encrypted: string // base64url AES-256-GCM ciphertext (GCM tag appended)
  iv: string // base64url 12-byte nonce
  ts: number // unix ms
}

/** Encrypt a JSON-serializable payload into a RelayEnvelope. */
export async function encryptPayload(payload: unknown, sharedKey: CryptoKey): Promise<RelayEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, plaintext)
  return {
    encrypted: base64url(ciphertext),
    iv: base64url(iv),
    ts: Date.now(),
  }
}

/** Decrypt a RelayEnvelope back to a parsed JSON object. Throws on wrong key or tampered data. */
export async function decryptEnvelope(envelope: RelayEnvelope, sharedKey: CryptoKey): Promise<unknown> {
  const iv = fromBase64url(envelope.iv)
  const ciphertext = fromBase64url(envelope.encrypted)
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, sharedKey, ciphertext)
  return JSON.parse(new TextDecoder().decode(plaintext))
}
