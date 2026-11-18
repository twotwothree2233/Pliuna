import { describe, expect, it } from 'vitest'
import type { ArtifactCandidate, ArtifactIndex, CompositionBatch, ContributionInventory, ContributionInventoryRef, DeliveryRecord, ExecutionAttempt, ExecutionScope, GoalRevision, LogicalWork, OutlineSection, PresentationPlan, RunnerRun, WorkOutputDeclaration } from '../../src/shared/contracts.generated'
import { queryDeliveries, validateArtifactCandidate, validatePresentationPlan, validateRunnerContract, type ArtifactAcceptanceContext } from '../../src/shared/runner-validation'
import { assertContract } from '../../src/shared/validation'
import { attachEvidence, requestEvidence } from '../../src/runtime/model/request-evidence'

const goal: GoalRevision = { task_id: 'task', request_id: 'request', intent_revision: 2, previous_revision: 1, input_event_id: 'input', state: 'active', requirements: [{ requirement_id: 'content', kind: 'artifact', required: true, provenance_required: true }] }
const run: RunnerRun = { task_id: 'task', run_id: 'run', purpose: 'production', request_id: 'request', intent_revision: 2, previous_run_id: 'old-run', runtime_epoch: 'epoch', state: 'running', commit_valid: true, budget_id: 'budget' }
const work: LogicalWork = { task_id: 'task', run_id: 'run', purpose: 'production', request_id: 'request', intent_revision: 2, work_id: 'work', plan_revision: 3, role: 'producer', required: true, requirement_ids: ['content'], dependencies: [{ kind: 'goal', task_id: 'task', request_id: 'upstream', intent_revision: 4 }], state: 'running', current_attempt_id: 'attempt', max_attempts: 2 }
const attempt: ExecutionAttempt = { task_id: 'task', run_id: 'run', purpose: 'production', request_id: 'request', intent_revision: 2, work_id: 'work', attempt_id: 'attempt', runtime_epoch: 'epoch', attempt_number: 2, previous_attempt_id: 'old-attempt', profile_id: 'producer', model_config_id: 'config', model_config_revision: 1, input_versions: work.dependencies, state: 'running', dispatch_state: 'dispatched', operation_id: 'operation', usage_refs: ['usage'] }
const section: OutlineSection = { section_id: 'section', request_id: 'request', intent_revision: 2, order_key: '10', position_revision: 1, title: 'Results' }
const index: ArtifactIndex = { task_id: 'task', request_id: 'request', intent_revision: 2, run_id: 'run', work_id: 'work', attempt_id: 'attempt', artifact_id: 'artifact', artifact_revision: 1, bundle_resource_id: 'body-resource', section_id: 'section', order_key: '10', presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: 'task', kind: 'record', id: 'provenance' }, acceptance_state: 'accepted', title: 'Results' }
const candidate: ArtifactCandidate = { task_id: index.task_id, request_id: index.request_id, intent_revision: index.intent_revision, run_id: index.run_id, work_id: index.work_id, attempt_id: index.attempt_id, artifact_id: index.artifact_id, bundle_resource_id: index.bundle_resource_id, section_id: index.section_id, order_key: index.order_key, presentation_kind: index.presentation_kind, width_constraint: index.width_constraint, interaction_kind: index.interaction_kind, provenance_ref: index.provenance_ref, candidate_id: 'candidate', base_artifact_revision: 0, plan_revision: 3, section_position_revision: 1, dependencies: work.dependencies, requirement_ids: ['content'], unresolved: [] }
const acceptance: ArtifactAcceptanceContext = { task_id: 'task', runtime_epoch: 'epoch', goal, run, work, attempt, section, current_artifact_revision: 0, resource_task_id: 'task' }
const batch: CompositionBatch = { task_id: 'task', batch_id: 'batch', composition_version: 2, run_id: 'composition', trigger_request_id: 'request', model_config_id: 'config', model_config_revision: 1, state: 'prepared', targets: [{ task_id: 'task', request_id: 'request', intent_revision: 2 }], indexes: [{ task_id: 'task', artifact_id: 'artifact', artifact_revision: 1 }], sections: [{ section_id: 'section', position_revision: 1, order_key: '10' }] }
const plan: PresentationPlan = { task_id: 'task', run_id: 'composition', batch_id: 'batch', composition_version: 2, intents: [{ artifact: batch.indexes[0]!, section_id: 'section', section_position_revision: 1, order_key: '10', slot_id: 'main', layout_mode: 'column', width_constraint: 'full' }] }
const final: DeliveryRecord = { delivery_id: 'final', task_id: 'task', run_id: 'run', work_id: 'query-work', attempt_id: 'query-attempt', role: 'lightweight', record_id: 'answer-record', input_event_id: 'query-input', request_id: 'request', intent_revision: 2, purpose: 'final_answer' }
const output: WorkOutputDeclaration = { task_id: 'task', request_id: 'request', intent_revision: 2, run_id: 'run', work_id: 'work', attempt_id: 'attempt', plan_revision: 3, result_revision: 4, result_ref: { task_id: 'task', kind: 'record', id: 'final-result' }, complete: true, artifacts: [{ task_id: 'task', artifact_id: 'artifact', artifact_revision: 1 }], requirement_ids: ['content'], unresolved: [] }
const inventory: ContributionInventory = { task_id: 'task', request_id: 'request', intent_revision: 2, inventory_revision: 2, previous_revision: 1, sealed_by: { run_id: 'run', work_id: 'work', attempt_id: 'attempt', plan_revision: 3, role: 'producer' }, required_works: [output], requirement_ids: ['content'], unresolved: [] }
const inventoryRef: ContributionInventoryRef = { task_id: 'task', request_id: 'request', intent_revision: 2, inventory_revision: 2 }

describe('runner identity contracts', () => {
  it('retains distinct goal, logical work and resumed execution identities', () => {
    expect(validateRunnerContract('runner_goal_revision', goal)).toEqual(goal)
    expect(validateRunnerContract('runner_run', run)).toMatchObject({ request_id: 'request', previous_run_id: 'old-run', budget_id: 'budget' })
    expect(validateRunnerContract('runner_logical_work', work)).toMatchObject({ work_id: 'work', current_attempt_id: 'attempt' })
    expect(validateRunnerContract('runner_execution_attempt', attempt)).toMatchObject({ work_id: 'work', previous_attempt_id: 'old-attempt', usage_refs: ['usage'] })
    expect(() => validateRunnerContract('runner_execution_attempt', { ...attempt, previous_attempt_id: 'attempt' })).toThrow('different predecessor')
  })

  it('gives composition its own source without a business goal identity', () => {
    const composition = { task_id: 'task', run_id: 'composition', purpose: 'composition', batch_id: 'batch', composition_version: 2, trigger_request_id: 'request', runtime_epoch: 'epoch', state: 'running', commit_valid: true, budget_id: 'composition-budget' }
    expect(validateRunnerContract('runner_run', composition)).toEqual(composition)
    expect(() => validateRunnerContract('runner_run', { ...composition, request_id: 'fake-goal', intent_revision: 1 })).toThrow('structure')
    expect(() => validateRunnerContract('runner_run', { ...run, state: 'completed' })).toThrow('commit authority')
  })

  it('rejects duplicate dependencies and cross-task exact inputs', () => {
    expect(() => validateRunnerContract('runner_logical_work', { ...work, dependencies: [...work.dependencies, ...work.dependencies] })).toThrow('Duplicate')
    expect(() => validateRunnerContract('runner_execution_attempt', { ...attempt, input_versions: [{ kind: 'resource', task_id: 'another-task', resource_id: 'private' }] })).toThrow('Execution source')
  })
})

describe('metadata-only composition contracts', () => {
  it('rejects body previews, unknown nested fields and unsupported presentation intents', () => {
    expect(validateRunnerContract('runner_artifact_index', index)).toEqual(index)
    for (const field of ['preview', 'body', 'summary', 'html']) expect(() => validateRunnerContract('runner_artifact_index', { ...index, [field]: 'private content' })).toThrow('structure')
    expect(() => validateRunnerContract('runner_artifact_index', { ...index, provenance_ref: { ...index.provenance_ref, preview: 'private content' } })).toThrow('structure')
    const context = { batch, indexes: [index], sections: [section] }
    expect(validatePresentationPlan(plan, context)).toEqual(plan)
    expect(() => validatePresentationPlan({ ...plan, html: '<p>rewrite</p>' }, context)).toThrow('structure')
    expect(() => validatePresentationPlan({ ...plan, intents: [{ ...plan.intents[0], slot_id: 'sidebar' }] }, context)).toThrow('structure')
    expect(() => validatePresentationPlan({ ...plan, intents: [{ ...plan.intents[0], layout_mode: 'freeform' }] }, context)).toThrow('structure')
    expect(() => validatePresentationPlan({ ...plan, intents: [{ ...plan.intents[0], body: 'rewrite' }] }, context)).toThrow('structure')
  })

  it('accepts exact current sources and rejects cross-task, stale, revoked or reassigned candidates', () => {
    expect(validateArtifactCandidate(candidate, acceptance)).toEqual(candidate)
    const failures: ArtifactAcceptanceContext[] = [
      { ...acceptance, resource_task_id: 'another-task' },
      { ...acceptance, runtime_epoch: 'new-epoch' },
      { ...acceptance, current_artifact_revision: 1 },
      { ...acceptance, goal: { ...goal, intent_revision: 3 } },
      { ...acceptance, run: { ...run, commit_valid: false } },
      { ...acceptance, work: { ...work, current_attempt_id: 'new-attempt' } },
      { ...acceptance, attempt: { ...attempt, state: 'revoked' } },
      { ...acceptance, section: { ...section, request_id: 'other-request' } },
      { ...acceptance, attempt: { ...attempt, input_versions: [{ kind: 'goal', task_id: 'task', request_id: 'upstream', intent_revision: 5 }] } }
    ]
    for (const context of failures) expect(() => validateArtifactCandidate(candidate, context)).toThrow('Execution source')
  })

  it('allows only exact accepted artifacts in the fixed batch and current positions', () => {
    const context = { batch, indexes: [index], sections: [section] }
    expect(() => validatePresentationPlan(plan, { ...context, indexes: [{ ...index, artifact_revision: 2 }] })).toThrow('Execution source')
    expect(() => validatePresentationPlan(plan, { ...context, sections: [{ ...section, position_revision: 2 }] })).toThrow('Execution source')
    expect(() => validatePresentationPlan(plan, { ...context, batch: { ...batch, indexes: [] } })).toThrow('Execution source')
    expect(() => validatePresentationPlan({ ...plan, intents: [...plan.intents, ...plan.intents] }, context)).toThrow('Duplicate')
  })

  it('keeps ownership errors free of rejected content', () => {
    try { validateRunnerContract('runner_artifact_index', { ...index, preview: 'never echo this body' }) } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain('never echo this body')
      expect(String(error)).not.toContain('preview')
    }
  })
})

describe('scope, delivery and request evidence contracts', () => {
  it('records distinct batches inside a stable whole-document scope', () => {
    const scope = { task_id: 'task', composition_version: 2, previous_version: 1, targets: [{ request_id: 'request', intent_revision: 2, required: true, requirement_ids: ['content'] }, { request_id: 'other', intent_revision: 1, required: true, requirement_ids: ['other-content'] }], state: 'working', unresolved: [{ task_id: 'task', request_id: 'other', intent_revision: 1, requirement_id: 'other-content' }] }
    expect(validateRunnerContract('runner_composition_scope', scope).targets).toHaveLength(2)
    expect(validateRunnerContract('runner_composition_batch', batch).composition_version).toBe(2)
    expect(validateRunnerContract('runner_composition_batch', { ...batch, batch_id: 'later-batch', previous_batch_id: 'batch' }).composition_version).toBe(2)
    expect(() => validateRunnerContract('runner_composition_scope', { ...scope, state: 'complete', publication_manifest_id: 'manifest' })).toThrow('unresolved')
  })

  it('requires frozen publication manifests to retain exact resources and resolved completeness', () => {
    const contribution = { task_id: 'task', batch_id: 'batch', request_id: 'request', intent_revision: 2, artifact_id: 'artifact', artifact_revision: 1, section_id: 'section', source_bundle_resource_id: 'source', published_bundle_resource_id: 'normalized', view_id: 'stable-view', view_revision: 2, state_revision: 1, surface_history_id: 'history' }
    const manifest = { manifest_id: 'manifest', task_id: 'task', composition_version: 2, operation_id: 'operation', action_id: 'action', surface_id: 'surface', surface_revision: 4, state: 'complete', targets: batch.targets, contributions: [contribution], unresolved: [] }
    expect(validateRunnerContract('runner_publication_manifest', manifest).contributions[0]).toMatchObject({ source_bundle_resource_id: 'source', published_bundle_resource_id: 'normalized' })
    expect(() => validateRunnerContract('runner_publication_manifest', { ...manifest, unresolved: [{ task_id: 'task', request_id: 'request', intent_revision: 2, requirement_id: 'content' }] })).toThrow('unresolved')
    expect(() => validateRunnerContract('runner_publication_manifest', { ...manifest, contributions: [{ ...contribution, task_id: 'other-task' }] })).toThrow('Execution source')
  })

  it('selects lightweight final answers separately from process and internal composition records', () => {
    const progress = { ...final, delivery_id: 'progress', purpose: 'progress' }
    const internal = { delivery_id: 'internal', task_id: 'task', run_id: 'composition', work_id: 'collation', attempt_id: 'collator-attempt', role: 'collator', record_id: 'internal-record', purpose: 'composition', batch_id: 'batch', composition_version: 2 }
    const values = [progress, final, internal, { ...final, delivery_id: 'other-final', input_event_id: 'other-input' }]
    expect(queryDeliveries(values, { task_id: 'task', purpose: 'final_answer', input_event_id: 'query-input', limit: 32 }).items).toEqual([final])
    const first = queryDeliveries(values, { task_id: 'task', purpose: 'final_answer', limit: 1 })
    expect(first).toEqual({ items: [final], next_after: 'final' })
    expect(queryDeliveries(values, { task_id: 'task', purpose: 'final_answer', limit: 1, after_delivery_id: first.next_after }).items[0]?.delivery_id).toBe('other-final')
    expect(() => queryDeliveries(values, { task_id: 'task', purpose: 'final_answer', limit: 32, after_delivery_id: 'progress' })).toThrow('page anchor')
    expect(() => validateRunnerContract('runner_delivery_record', { ...internal, purpose: 'final_answer' })).toThrow('structure')
  })

  it('retains target, role, work and attempt in request evidence without copying them into provider messages', () => {
    const owner: ExecutionScope = { task_id: 'task', run_id: 'run', work_id: 'work', attempt_id: 'attempt', purpose: 'production', request_id: 'request', intent_revision: 2, role: 'producer' }
    const message = attachEvidence({ role: 'user', content: 'input' }, { kind: 'message.user', representation: 'recorded-message', owner })
    const evidence = requestEvidence([message], 'model-request', 'main', owner)
    expect(evidence.owner).toEqual(owner)
    expect(evidence.entries[0]?.owner).toEqual(owner)
    expect(() => assertContract('request_evidence', evidence)).not.toThrow()
    expect(message).toEqual({ role: 'user', content: 'input' })
  })
})

describe('complete work outputs and sealed contribution inventories', () => {
  it('requires explicit complete enumeration and exact work, plan, result and attempt bindings', () => {
    expect(validateRunnerContract('runner_work_output_declaration', output)).toEqual(output)
    for (const field of ['complete', 'artifacts', 'plan_revision', 'result_revision', 'result_ref', 'attempt_id']) {
      const incomplete: Record<string, unknown> = { ...output }
      delete incomplete[field]
      expect(() => validateRunnerContract('runner_work_output_declaration', incomplete)).toThrow('structure')
    }
    expect(() => validateRunnerContract('runner_work_output_declaration', { ...output, complete: false })).toThrow('structure')
    const { complete: _complete, ...withoutDeclaration } = output
    expect(() => validateRunnerContract('runner_work_output_declaration', { ...withoutDeclaration, state: 'succeeded' })).toThrow('structure')
    expect(validateRunnerContract('runner_work_output_declaration', { ...output, artifacts: [] }).artifacts).toEqual([])
  })

  it('retains complete fragment inventories beyond batch and index page limits', () => {
    const outputs = [0, 1].map(number => ({
      ...output, work_id: number === 0 ? 'work' : 'other-work', attempt_id: number === 0 ? 'attempt' : 'other-attempt',
      result_ref: { ...output.result_ref, id: `result-${number}` },
      artifacts: Array.from({ length: 20 }, (_, position) => ({ task_id: 'task', artifact_id: `fragment-${number}-${position}`, artifact_revision: position + 1 }))
    }))
    const accepted = validateRunnerContract('runner_contribution_inventory', { ...inventory, required_works: outputs })
    expect(accepted.required_works.flatMap(item => item.artifacts)).toEqual(outputs.flatMap(item => item.artifacts))
    expect(accepted.required_works.flatMap(item => item.artifacts)).toHaveLength(40)
  })

  it('allows Router or direct Producer seal sources and excludes every other role', () => {
    for (const role of ['router', 'producer']) {
      expect(validateRunnerContract('runner_contribution_inventory', { ...inventory, sealed_by: { ...inventory.sealed_by, role } }).sealed_by.role).toBe(role)
    }
    for (const role of ['collator', 'lightweight', 'integrator', 'diagnostic', 'worker']) {
      expect(() => validateRunnerContract('runner_contribution_inventory', { ...inventory, sealed_by: { ...inventory.sealed_by, role } })).toThrow('structure')
    }
    expect(() => validateRunnerContract('runner_contribution_inventory', { ...inventory, sealed_by: { ...inventory.sealed_by, attempt_id: 'different-attempt' } })).toThrow('Execution source')
    expect(() => validateRunnerContract('runner_contribution_inventory', { ...inventory, sealed_by: { ...inventory.sealed_by, plan_revision: 4 } })).toThrow('Execution source')
  })

  it('rejects output ownership crossing the Task or exact goal revision', () => {
    const invalidOutputs = [
      { ...output, task_id: 'another-task' },
      { ...output, request_id: 'another-goal' },
      { ...output, intent_revision: 3 },
      { ...output, artifacts: [{ ...output.artifacts[0], task_id: 'another-task' }] },
      { ...output, result_ref: { ...output.result_ref, task_id: 'another-task' } },
      { ...output, unresolved: [{ task_id: 'task', request_id: 'another-goal', intent_revision: 2, requirement_id: 'content' }] },
      { ...output, unresolved: [{ task_id: 'task', request_id: 'request', intent_revision: 3, requirement_id: 'content' }] }
    ]
    for (const invalidOutput of invalidOutputs) {
      expect(() => validateRunnerContract('runner_contribution_inventory', { ...inventory, required_works: [invalidOutput] })).toThrow('Execution source')
    }
    expect(() => validateRunnerContract('runner_work_output_declaration', invalidOutputs[5])).toThrow('Execution source')
  })

  it('rejects ambiguous duplicate works and fragment versions', () => {
    expect(() => validateRunnerContract('runner_contribution_inventory', { ...inventory, required_works: [output, { ...output, plan_revision: 4, result_revision: 5 }] })).toThrow('Duplicate inventory work')
    expect(() => validateRunnerContract('runner_work_output_declaration', { ...output, artifacts: [...output.artifacts, { ...output.artifacts[0], artifact_revision: 2 }] })).toThrow('Duplicate output artifacts')
    expect(() => validateRunnerContract('runner_contribution_inventory', { ...inventory, required_works: [output, { ...output, work_id: 'other-work' }] })).toThrow('Duplicate inventory artifacts')
    expect(() => validateRunnerContract('runner_contribution_inventory', { ...inventory, required_works: [{ ...output, requirement_ids: ['content', 'content'] }] })).toThrow('Duplicate output requirements')
  })

  it('keeps enumeration closure separate from unresolved semantic or source review', () => {
    const unresolved = { task_id: 'task', request_id: 'request', intent_revision: 2, requirement_id: 'content' }
    const pendingOutput = { ...output, unresolved: [unresolved] }
    const pendingInventory = { ...inventory, required_works: [pendingOutput], unresolved: [unresolved] }
    expect(validateRunnerContract('runner_work_output_declaration', pendingOutput)).toEqual(pendingOutput)
    expect(validateRunnerContract('runner_contribution_inventory', pendingInventory)).toEqual(pendingInventory)
    expect(() => validateRunnerContract('runner_contribution_inventory', { ...pendingInventory, unresolved: [] })).toThrow('cannot omit unresolved')
    expect(() => validateRunnerContract('runner_contribution_inventory', { ...pendingInventory, unresolved: [unresolved, unresolved] })).toThrow('Duplicate')
    expect(() => validateRunnerContract('runner_work_output_declaration', { ...pendingOutput, unresolved: [unresolved, unresolved] })).toThrow('Duplicate')
    expect(() => validateRunnerContract('runner_contribution_inventory', { ...inventory, unresolved: [{ ...unresolved, request_id: 'another-goal' }] })).toThrow('Execution source')
  })

  it('does not invent coverage and permits inventory-level unresolved requirements', () => {
    const missing = { task_id: 'task', request_id: 'request', intent_revision: 2, requirement_id: 'source-check' }
    expect(validateRunnerContract('runner_contribution_inventory', { ...inventory, unresolved: [missing] }).unresolved).toEqual([missing])
    expect(validateRunnerContract('runner_contribution_inventory', { ...inventory, requirement_ids: [], unresolved: [missing] }).requirement_ids).toEqual([])
    expect(() => validateRunnerContract('runner_contribution_inventory', { ...inventory, requirement_ids: ['content', 'source-check'] })).toThrow('coverage')
    expect(() => validateRunnerContract('runner_contribution_inventory', { ...inventory, required_works: [] })).toThrow('coverage')
  })

  it('requires advancing safe revision identities without truncating them', () => {
    expect(validateRunnerContract('runner_contribution_inventory_ref', inventoryRef)).toEqual(inventoryRef)
    for (const inventory_revision of [0, 1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateRunnerContract('runner_contribution_inventory', { ...inventory, inventory_revision })).toThrow()
    }
    expect(() => validateRunnerContract('runner_contribution_inventory', { ...inventory, previous_revision: 2 })).toThrow('advance')
    for (const result_revision of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateRunnerContract('runner_work_output_declaration', { ...output, result_revision })).toThrow('structure')
    }
    expect(() => validateRunnerContract('runner_contribution_inventory_ref', { ...inventoryRef, inventory_revision: 0 })).toThrow('structure')
    expect(() => validateRunnerContract('runner_contribution_inventory_ref', { ...inventoryRef, request_id: '目'.repeat(43) })).toThrow('UTF-8')
  })

  it('requires exact inventory bindings only when a required scope target becomes complete', () => {
    const target = { request_id: 'request', intent_revision: 2, required: true, requirement_ids: ['content'] }
    const working = { task_id: 'task', composition_version: 2, targets: [target], state: 'working', unresolved: [] }
    const complete = { ...working, state: 'complete', publication_manifest_id: 'manifest' }
    expect(validateRunnerContract('runner_composition_scope', working).state).toBe('working')
    expect(() => validateRunnerContract('runner_composition_scope', complete)).toThrow('sealed inventory')
    const bound = { ...target, contribution_inventory: inventoryRef }
    expect(validateRunnerContract('runner_composition_scope', { ...complete, targets: [bound] }).targets[0]?.contribution_inventory).toEqual(inventoryRef)
    expect(validateRunnerContract('runner_composition_scope', { ...complete, targets: [bound, { ...target, request_id: 'optional', required: false }] }).state).toBe('complete')
    for (const reference of [{ ...inventoryRef, task_id: 'another-task' }, { ...inventoryRef, request_id: 'another-goal' }, { ...inventoryRef, intent_revision: 1 }]) {
      expect(() => validateRunnerContract('runner_composition_scope', { ...working, targets: [{ ...target, contribution_inventory: reference }] })).toThrow('Execution source')
    }
  })

  it('rejects body or invented acceptance fields at every declaration boundary without echoing them', () => {
    const invalidValues = [
      { ...inventory, body: 'private body' },
      { ...inventory, semantic_accepted: true },
      { ...inventory, required_works: [{ ...output, preview: 'private body' }] },
      { ...inventory, required_works: [{ ...output, artifacts: [{ ...output.artifacts[0], body: 'private body' }] }] },
      { ...inventory, sealed_by: { ...inventory.sealed_by, authority: 'private body' } }
    ]
    for (const value of invalidValues) {
      expect(() => validateRunnerContract('runner_contribution_inventory', value)).toThrow('structure')
      try { validateRunnerContract('runner_contribution_inventory', value) } catch (error) {
        expect(String(error)).not.toContain('private body')
        expect(String(error)).not.toContain('preview')
        expect(String(error)).not.toContain('authority')
      }
    }
  })
})
