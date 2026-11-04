import { readFile, writeFile } from 'node:fs/promises'
import { compile } from 'json-schema-to-typescript'
const schema = JSON.parse(await readFile('src/shared/contracts/core.schema.json', 'utf8'))
const names = { Summary: 'summary', SyncDelta: 'sync_delta', Bundle: 'bundle', IpcRequest: 'ipc_request', ModelRequest: 'model_request', LocalSchema: 'local_schema', ModelConfiguration: 'model_configuration', HostModelRequest: 'host_model_request', HostPluginRequest: 'host_plugin_request' }
let output = '/* Generated from src/shared/contracts/core.schema.json. Do not edit. */\n'
for (const [name, definition] of Object.entries(names)) {
  // Prefix nested definitions to keep independently generated roots collision-free.
  const prefix = name + '_'
  const text = JSON.stringify(schema.$defs).replaceAll('#/$defs/', '#/definitions/' + prefix)
  const defs = Object.fromEntries(Object.entries(JSON.parse(text)).map(([key, value]) => [prefix + key, value]))
  output += await compile({ ...defs[prefix + definition], definitions: defs }, name, {
    bannerComment: '', additionalProperties: false, unreachableDefinitions: false, format: false
  })
}
await writeFile('src/shared/contracts.generated.ts', output)
