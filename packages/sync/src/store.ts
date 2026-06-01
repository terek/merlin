/**
 * SyncStore interface — the minimal contract the SyncEngine needs.
 *
 * The engine is shape-agnostic: it diffs opaque objects via JSON Patch.
 * Concrete stores (e.g. ModelStore in the daemon) implement this interface
 * and provide domain-specific mutations on top.
 */

export type ModelListener = () => void
export type SessionListener = (sessionId: string) => void

export interface SyncStore {
  getModel(): object
  getActiveSession(sessionId: string): object | undefined
  onModelChange(listener: ModelListener): () => void
  onSessionChange(listener: SessionListener): () => void
}
