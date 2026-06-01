import { describe, expect, test } from 'bun:test'
import {
  base64url,
  decryptEnvelope,
  deriveSharedKey,
  encryptPayload,
  exportAesKey,
  exportKeypair,
  fromBase64url,
  generateKeypair,
  importAesKey,
  importKeypair,
} from '@merlin/relay'

describe('crypto — base64url', () => {
  test('round-trip', () => {
    const buf = new Uint8Array([1, 2, 3, 255, 0])
    const encoded = base64url(buf.buffer)
    const decoded = fromBase64url(encoded)
    expect(Array.from(decoded)).toEqual([1, 2, 3, 255, 0])
  })
})

describe('crypto — AES-256-GCM encrypt/decrypt', () => {
  test('round-trip', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const payload = { type: 'ping' }
    const envelope = await encryptPayload(payload, key)
    const decrypted = await decryptEnvelope(envelope, key)
    expect(decrypted).toEqual(payload)
  })

  test('wrong key throws', async () => {
    const key1 = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const key2 = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const envelope = await encryptPayload({ type: 'ping' }, key1)
    await expect(decryptEnvelope(envelope, key2)).rejects.toThrow()
  })

  test('envelope structure', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const envelope = await encryptPayload({ type: 'sessions', sessions: [] }, key)
    expect(typeof envelope.encrypted).toBe('string')
    expect(typeof envelope.iv).toBe('string')
    expect(typeof envelope.ts).toBe('number')
    // Encrypted data is not the plaintext
    expect(envelope.encrypted).not.toContain('sessions')
  })

  test('each encryption produces unique IV', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const e1 = await encryptPayload({ x: 1 }, key)
    const e2 = await encryptPayload({ x: 1 }, key)
    expect(e1.iv).not.toBe(e2.iv)
  })

  test('tampered ciphertext throws', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const envelope = await encryptPayload({ type: 'test' }, key)
    // Corrupt by reversing the ciphertext (breaks GCM auth tag)
    const reversed = envelope.encrypted.split('').reverse().join('')
    const tampered = { ...envelope, encrypted: reversed }
    await expect(decryptEnvelope(tampered, key)).rejects.toThrow()
  })

  test('tampered IV throws', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const envelope = await encryptPayload({ type: 'test' }, key)
    const tampered = { ...envelope, iv: base64url(crypto.getRandomValues(new Uint8Array(12))) }
    await expect(decryptEnvelope(tampered, key)).rejects.toThrow()
  })
})

describe('crypto — ECDH key exchange', () => {
  test('both sides derive the same working key', async () => {
    const daemonKp = await generateKeypair()
    const clientKp = await generateKeypair()

    const daemonShared = await deriveSharedKey(daemonKp.privateKey, clientKp.publicKeySpki)
    const clientShared = await deriveSharedKey(clientKp.privateKey, daemonKp.publicKeySpki)

    // Encrypt with daemon's key, decrypt with client's key
    const payload = { type: 'state_update', data: 'test' }
    const envelope = await encryptPayload(payload, daemonShared)
    const decrypted = await decryptEnvelope(envelope, clientShared)
    expect(decrypted).toEqual(payload)
  })

  test('different keypairs produce different shared keys', async () => {
    const kp1 = await generateKeypair()
    const kp2 = await generateKeypair()
    const kp3 = await generateKeypair()

    const shared12 = await deriveSharedKey(kp1.privateKey, kp2.publicKeySpki)
    const shared13 = await deriveSharedKey(kp1.privateKey, kp3.publicKeySpki)

    const exported12 = await exportAesKey(shared12)
    const exported13 = await exportAesKey(shared13)
    expect(exported12).not.toBe(exported13)
  })

  test('third party cannot decrypt with their own keypair', async () => {
    const daemon = await generateKeypair()
    const client = await generateKeypair()
    const attacker = await generateKeypair()

    const sharedKey = await deriveSharedKey(daemon.privateKey, client.publicKeySpki)
    const attackerKey = await deriveSharedKey(attacker.privateKey, daemon.publicKeySpki)

    const envelope = await encryptPayload({ secret: 'data' }, sharedKey)
    await expect(decryptEnvelope(envelope, attackerKey)).rejects.toThrow()
  })
})

describe('crypto — keypair export/import', () => {
  test('round-trip', async () => {
    const kp = await generateKeypair()
    const exported = await exportKeypair(kp)
    const imported = await importKeypair(exported)

    expect(imported.publicKeySpki).toBe(kp.publicKeySpki)

    // Verify imported keypair works for key derivation
    const peer = await generateKeypair()
    const shared1 = await deriveSharedKey(kp.privateKey, peer.publicKeySpki)
    const shared2 = await deriveSharedKey(imported.privateKey, peer.publicKeySpki)

    const e1 = await exportAesKey(shared1)
    const e2 = await exportAesKey(shared2)
    expect(e1).toBe(e2)
  })
})

describe('crypto — AES key export/import', () => {
  test('round-trip', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const exported = await exportAesKey(key)
    const imported = await importAesKey(exported)

    const payload = { test: true }
    const envelope = await encryptPayload(payload, key)
    const decrypted = await decryptEnvelope(envelope, imported)
    expect(decrypted).toEqual(payload)
  })
})
