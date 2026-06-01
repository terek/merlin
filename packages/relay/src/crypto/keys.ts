/**
 * ECDH P-256 key generation and AES-256-GCM key derivation.
 * Uses WebCrypto (works in Bun, Node, browsers, and Deno).
 */

export function base64url(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString('base64url')
}

export function fromBase64url(s: string): Uint8Array {
  return Buffer.from(s, 'base64url')
}

export interface Keypair {
  privateKey: CryptoKey
  publicKey: CryptoKey
  publicKeySpki: string // SPKI base64url
}

/** Generate a fresh ECDH P-256 keypair. */
export async function generateKeypair(): Promise<Keypair> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const publicKeyBuf = await crypto.subtle.exportKey('spki', keyPair.publicKey)
  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicKeySpki: base64url(publicKeyBuf),
  }
}

/** Export keypair to storable format (PKCS8 + SPKI, base64url). */
export async function exportKeypair(kp: Keypair): Promise<{ privateKey: string; publicKey: string }> {
  const privateKeyBuf = await crypto.subtle.exportKey('pkcs8', kp.privateKey)
  return { privateKey: base64url(privateKeyBuf), publicKey: kp.publicKeySpki }
}

/** Import keypair from stored format. */
export async function importKeypair(stored: { privateKey: string; publicKey: string }): Promise<Keypair> {
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    fromBase64url(stored.privateKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )
  const publicKey = await crypto.subtle.importKey(
    'spki',
    fromBase64url(stored.publicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  )
  return { privateKey, publicKey, publicKeySpki: stored.publicKey }
}

/**
 * Derive a shared AES-256-GCM key from our private key and peer's public key (SPKI base64url).
 * Uses ECDH + HKDF(SHA-256, salt=empty, info="merlin-v1").
 */
export async function deriveSharedKey(privateKey: CryptoKey, peerPublicKeySpki: string): Promise<CryptoKey> {
  const peerPublicKey = await crypto.subtle.importKey(
    'spki',
    fromBase64url(peerPublicKeySpki),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )

  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPublicKey }, privateKey, 256)

  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey'])

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('merlin-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
}

/** Export AES key to base64url string for storage. */
export async function exportAesKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key)
  return base64url(raw)
}

/** Import AES key from base64url string. */
export async function importAesKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromBase64url(b64), { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])
}
