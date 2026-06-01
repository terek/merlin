import { CCSession, type CCSessionOptions } from './session.ts'

export interface SpawnOptions {
  id: string
  cwd: string
  ccSessionId?: string // if set, adds --resume <sessionId>
  agentBinary?: string
  bufferCapacity?: number
}

/**
 * Create and start a CCSession. Preloads history if resuming an existing session.
 */
export async function spawnCCSession(opts: SpawnOptions, jsonlPath?: string): Promise<CCSession> {
  const sessionOpts: CCSessionOptions = {
    id: opts.id,
    workingDirectory: opts.cwd,
    agentBinary: opts.agentBinary,
    resumeSessionId: opts.ccSessionId,
    bufferCapacity: opts.bufferCapacity,
  }

  const session = new CCSession(sessionOpts)

  // Preload history from JSONL if resuming (so client has context immediately)
  if (jsonlPath) {
    await session.preloadHistory(jsonlPath)
  }

  await session.start()
  return session
}
