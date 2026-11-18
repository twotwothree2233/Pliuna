import { readFile, writeFile } from 'node:fs/promises'
import { compile } from 'json-schema-to-typescript'
const schema = JSON.parse(await readFile('src/shared/contracts/core.schema.json', 'utf8'))
const names = { Summary: 'summary', SyncDelta: 'sync_delta', Bundle: 'bundle', IpcRequest: 'ipc_request', ModelRequest: 'model_request', LocalSchema: 'local_schema', ModelConfiguration: 'model_configuration', HostModelRequest: 'host_model_request', HostPluginRequest: 'host_plugin_request' }
Object.assign(names, {
  InputEvent: 'runner_input_event', ConsumptionStage: 'runner_consumption_stage', OutcomeRequirement: 'runner_outcome_requirement',
  GoalRevision: 'runner_goal_revision', WorkDependency: 'runner_work_dependency', RunnerRun: 'runner_run', LogicalWork: 'runner_logical_work',
  ExecutionAttempt: 'runner_execution_attempt', ExecutionScope: 'runner_execution_scope', Outline: 'runner_outline', OutlineSection: 'runner_outline_section',
  ArtifactIndex: 'runner_artifact_index', ArtifactCandidate: 'runner_artifact_candidate', PresentationPlan: 'runner_presentation_plan',
  CompositionScope: 'runner_composition_scope', CompositionBatch: 'runner_composition_batch', DeliveryRecord: 'runner_delivery_record',
  DeliveryQuery: 'runner_delivery_query', PublicationManifest: 'runner_publication_manifest', PublicationEntry: 'runner_publication_entry',
  WorkOutputDeclaration: 'runner_work_output_declaration', ContributionInventory: 'runner_contribution_inventory', ContributionInventoryRef: 'runner_contribution_inventory_ref'
})
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
