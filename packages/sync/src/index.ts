/**
 * @merlin/sync -- Shape-agnostic state synchronization via JSON Patch.
 */

export { type SyncClient, SyncEngine } from './engine.ts'
export { applyOps, generatePatch, snapshot } from './patch.ts'
export type { ModelListener, SessionListener, SyncStore } from './store.ts'
