/**
 * Gateway connectors: relay connector lifecycle management.
 */

import type { ClientMessage, DaemonMessage } from '@merlin/protocol'
import { ClientMessageSchema } from '@merlin/protocol'
import { RelayConnector } from '@merlin/relay'
import type { SyncEngine } from '@merlin/sync'
import type { LogFn, RelayPairing } from '../daemon.ts'

export class ConnectorManager {
  private connectors: RelayConnector[] = []

  constructor(
    private syncEngine: SyncEngine,
    private onMessage: (clientId: string, msg: ClientMessage) => void,
    private log: LogFn,
  ) {}

  addConnector(pairing: RelayPairing): void {
    this._addConnector(pairing, this.connectors.length)
  }

  /** Close all connectors and reconnect with a new set (used after pairing deletion). */
  reconnectPairings(pairings: RelayPairing[]): void {
    for (const c of this.connectors) c.close()
    this.connectors = []
    for (let i = 0; i < pairings.length; i++) {
      this._addConnector(pairings[i], i)
    }
  }

  connectAll(pairings: RelayPairing[]): void {
    for (let i = 0; i < pairings.length; i++) {
      this._addConnector(pairings[i], i)
    }
  }

  closeAll(): void {
    for (const connector of this.connectors) {
      connector.close()
    }
    this.connectors = []
  }

  private _addConnector(pairing: RelayPairing, index: number): void {
    const clientId = `relay-${index}`
    const connector = new RelayConnector<ClientMessage, DaemonMessage>({
      relayUrl: pairing.relayUrl,
      token: pairing.token,
      sharedKey: pairing.sharedKey,
      parseMessage: (raw) => {
        const result = ClientMessageSchema.safeParse(raw)
        return result.success ? result.data : null
      },
      onMessage: (msg) => this.onMessage(clientId, msg),
      onOpen: () => {
        this.log(`relay connected [${index}] (${pairing.relayUrl})`)
        this.syncEngine.addClient({
          id: clientId,
          sendMessage: (msg) => {
            void connector.send(JSON.parse(msg) as DaemonMessage)
          },
        })
      },
      onClose: () => {
        this.log(`relay disconnected [${index}]`)
        this.syncEngine.removeClient(clientId)
      },
    })
    this.connectors.push(connector)
    connector.connect()
  }
}
