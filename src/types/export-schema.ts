#!/usr/bin/env bun

/**
 * Export JSON Schema files from Zod schemas.
 * Run: bun src/types/export-schema.ts
 * Output: schema/client-message.json, schema/daemon-message.json, schema/model.json
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ActiveSessionSchema, ClientMessageSchema, DaemonMessageSchema, MerlinModelSchema } from '@merlin/protocol'
import { toJSONSchema } from 'zod'

const outDir = path.join(import.meta.dir, '../../schema')
mkdirSync(outDir, { recursive: true })

function write(name: string, schema: unknown) {
  const file = path.join(outDir, `${name}.json`)
  writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`)
  console.log(`  ${file}`)
}

console.log('Exporting JSON Schema:')
write('client-message', toJSONSchema(ClientMessageSchema))
write('daemon-message', toJSONSchema(DaemonMessageSchema))
write('model', toJSONSchema(MerlinModelSchema))
write('active-session', toJSONSchema(ActiveSessionSchema))
