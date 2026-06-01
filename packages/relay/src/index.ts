/**
 * @merlin/relay -- E2E encrypted relay connectivity and pairing.
 */

// ---------------------------------------------------------------------------
// Crypto primitives
// ---------------------------------------------------------------------------

export {
  decryptEnvelope,
  encryptPayload,
  type RelayEnvelope,
} from './crypto/envelope.ts'
export {
  base64url,
  deriveSharedKey,
  exportAesKey,
  exportKeypair,
  fromBase64url,
  generateKeypair,
  importAesKey,
  importKeypair,
  type Keypair,
} from './crypto/keys.ts'

// ---------------------------------------------------------------------------
// Relay connector (generic, E2E encrypted WebSocket client)
// ---------------------------------------------------------------------------

export { RelayConnector, type RelayConnectorOptions } from './connector.ts'

// ---------------------------------------------------------------------------
// Relay server (Bun WebSocket broker)
// ---------------------------------------------------------------------------

export { type QueuedMessage, Room, type SocketData } from './room.ts'
export { createRelay } from './server.ts'

// ---------------------------------------------------------------------------
// Pairing (daemon-side initiate + client-side join + storage)
// ---------------------------------------------------------------------------

export { type InitiatePairingOptions, initiatePairing, type PairingResult } from './pairing/initiate.ts'
export { type JoinResult, joinPairing } from './pairing/join.ts'
export {
  addPairing,
  deleteAllPairings,
  loadOrGenerateKeypair,
  loadPairing,
  loadPairings,
  loadSharedKey,
  type StoredKeypair,
  type StoredPairing,
  savePairing,
  savePairings,
} from './pairing/storage.ts'
