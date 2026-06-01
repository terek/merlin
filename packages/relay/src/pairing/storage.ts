/**
 * Persistent pairing state storage.
 * Stores an array of pairings (one per client) and ECDH keypairs.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { exportKeypair, importAesKey, importKeypair, type Keypair } from '../crypto/keys.ts'

const DEFAULT_DIR = path.join(os.homedir(), '.merlin')

export interface StoredPairing {
  sessionToken: string
  sharedKey: string // base64url AES-256 key
  relayUrl: string
  daemonName?: string
}

export interface StoredKeypair {
  privateKey: string // PKCS8 base64url
  publicKey: string // SPKI base64url
}

const keypairPath = (name: string, dir: string) => path.join(dir, `keypair-${name}.json`)
const pairingsPath = (name: string, dir: string) => path.join(dir, `pairings-${name}.json`)
const legacyPairingPath = (name: string, dir: string) => path.join(dir, `pairing-${name}.json`)

/** Load or generate an ECDH keypair, persisted to {baseDir}/keypair-{name}.json. */
export async function loadOrGenerateKeypair(name: string, baseDir = DEFAULT_DIR): Promise<Keypair> {
  const kpPath = keypairPath(name, baseDir)
  try {
    const raw = await fs.readFile(kpPath, 'utf-8')
    return await importKeypair(JSON.parse(raw) as StoredKeypair)
  } catch {
    // Generate new
    const { generateKeypair } = await import('../crypto/keys.ts')
    const kp = await generateKeypair()
    const stored = await exportKeypair(kp)
    await fs.mkdir(baseDir, { recursive: true })
    await fs.writeFile(kpPath, JSON.stringify(stored, null, 2), { mode: 0o600 })
    return kp
  }
}

/** Load all stored pairings. Migrates from legacy single-pairing format if needed. */
export async function loadPairings(name: string, baseDir = DEFAULT_DIR): Promise<StoredPairing[]> {
  try {
    const raw = await fs.readFile(pairingsPath(name, baseDir), 'utf-8')
    return JSON.parse(raw) as StoredPairing[]
  } catch {
    // Try migrating legacy single pairing
    try {
      const raw = await fs.readFile(legacyPairingPath(name, baseDir), 'utf-8')
      const legacy = JSON.parse(raw) as StoredPairing
      const pairings = [legacy]
      await savePairings(name, pairings, baseDir)
      // Remove legacy file after successful migration
      try {
        await fs.unlink(legacyPairingPath(name, baseDir))
      } catch {}
      return pairings
    } catch {
      return []
    }
  }
}

/** Save all pairings. */
export async function savePairings(name: string, pairings: StoredPairing[], baseDir = DEFAULT_DIR): Promise<void> {
  await fs.mkdir(baseDir, { recursive: true })
  await fs.writeFile(pairingsPath(name, baseDir), JSON.stringify(pairings, null, 2), { mode: 0o600 })
}

/** Append a new pairing. */
export async function addPairing(name: string, pairing: StoredPairing, baseDir = DEFAULT_DIR): Promise<void> {
  const pairings = await loadPairings(name, baseDir)
  pairings.push(pairing)
  await savePairings(name, pairings, baseDir)
}

/** Delete all pairings. */
export async function deleteAllPairings(name: string, baseDir = DEFAULT_DIR): Promise<void> {
  try {
    await fs.unlink(pairingsPath(name, baseDir))
  } catch {}
}

// -- Single-pairing helpers (used by TUI client) --

/** Load a single stored pairing (client-side, e.g. TUI). Returns null if not paired. */
export async function loadPairing(name: string, baseDir = DEFAULT_DIR): Promise<StoredPairing | null> {
  try {
    const raw = await fs.readFile(legacyPairingPath(name, baseDir), 'utf-8')
    return JSON.parse(raw) as StoredPairing
  } catch {
    return null
  }
}

/** Save a single pairing (client-side, e.g. TUI). */
export async function savePairing(name: string, pairing: StoredPairing, baseDir = DEFAULT_DIR): Promise<void> {
  await fs.mkdir(baseDir, { recursive: true })
  await fs.writeFile(legacyPairingPath(name, baseDir), JSON.stringify(pairing, null, 2), { mode: 0o600 })
}

// -- Shared helpers --

/** Helper: load the CryptoKey from a stored pairing. */
export async function loadSharedKey(pairing: StoredPairing): Promise<CryptoKey> {
  return importAesKey(pairing.sharedKey)
}
