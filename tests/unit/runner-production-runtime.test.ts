import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatAdapter, type Completion } from '../../src/runtime/model/adapter'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'
import { RunnerArtifactState } from '../../src/runtime/runner/artifact-state'
import { RunnerHostProduction } from '../../src/runtime/runner/host-production'
import { RunnerCompositionState } from '../../src/runtime/runner/composition-state'
import type { ProducerResult } from '../../src/runtime/runner/production-profile'
import { RuntimeStore } from '../../src/runtime/store'
import type { ArtifactCandidate, Bundle, LogicalWork, ModelConfiguration, WorkDependency } from '../../src/shared/contracts.generated'
import { modelToolRequest } from '../../src/runtime/model/tool-input'
import type { PluginControl } from '../../src/runtime/plugins/control'

const stores: RuntimeStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks() })
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => resolve(value) } }
const answer = (text: string): Completion => ({ text, calls: [], finish: 'stop', usage: { prompt_tokens: 30, completion_tokens: 8 } })
function setup(runner: { productionRuns: 1 | 2; collator?: 'rule' | 'model' } | null = { productionRuns: 2 }) {
  const adapter = new ChatAdapter(), models = new ModelService(adapter)
  const config: ModelConfiguration = { id: 'production', base_url: 'https://example.invalid/v1', wire_model_id: 'synthetic', context_tokens: 100000, max_output_tokens: 4096, compatibility_profile: 'chat-max-tokens' }
  models.configure({ type: 'model.configure', configuration: config, api_key: 'synthetic', confirm_memory_only: true })
  const release = vi.fn()
  vi.spyOn(models, 'acquire').mockImplementation((): ModelLease => ({ id: config.id, revision: 1, config, release }))
  vi.spyOn(models, 'acquireCompaction').mockReturnValue(undefined)
  const complete = vi.spyOn(adapter, 'complete')
  const store = new RuntimeStore(mkdtempSync(join(tmpdir(), 'pliuna-production-')), models, { viewReplacement: true, ...(runner ? { runner } : {}) })
  stores.push(store)
  const internal = store as unknown as { db: Database.Database; epoch: string }
  const task = store.create('Production acceptance').task.id, db = internal.db, state = new RunnerWorkState(db, internal.epoch)
  const records = (kind: string) => (db.prepare('SELECT payload_json FROM records WHERE task_id=? AND kind=? ORDER BY sequence').all(task, kind) as { payload_json: string }[]).map(row => JSON.parse(row.payload_json))
  const request = (run: string) => (db.prepare('SELECT request_id FROM runs WHERE id=?').get(run) as { request_id: string }).request_id
  return { store, db, state, task, complete, release, records, request }
}
function content(text: string): Bundle {
  return { profile: 'managed-v1', html: `<section><p>${text}</p></section>`, css: '', state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'v1' }, forms: [], behaviors: [], references: [], export: [] }
}
function provenanceResult(s: ReturnType<typeof setup>, bundle_resource_id: string, provenance_ref: ArtifactCandidate['provenance_ref'], candidate_id: string): ProducerResult {
  const work = s.state.taskWorks(s.task).find(item => item.role === 'producer')
  if (!work || work.purpose !== 'production') throw Error('Expected producer')
  const section = new RunnerArtifactState(s.db, s.state).outline(s.task)!.sections.find(item => item.request_id === work.request_id)!
  const candidate: ArtifactCandidate = {
    task_id: s.task, request_id: work.request_id, intent_revision: work.intent_revision, run_id: work.run_id, work_id: work.work_id,
    attempt_id: work.current_attempt_id!, plan_revision: work.plan_revision, dependencies: work.dependencies,
    artifact_id: 'provenance-artifact', candidate_id, base_artifact_revision: 0, bundle_resource_id,
    section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key,
    presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref, requirement_ids: ['answer'], unresolved: []
  }
  return { version: 1, complete: true, answer: 'Artifact is ready.', artifacts: [candidate], requirement_ids: ['answer'], unresolved: [] }
}
function integration(s: ReturnType<typeof setup>, producer: LogicalWork, dependencies: WorkDependency[]) {
  if (producer.purpose !== 'production') throw Error('Expected production source')
  const work: LogicalWork = { task_id: s.task, run_id: producer.run_id, work_id: 'integrator', plan_revision: 1, role: 'integrator', required: true, requirement_ids: ['answer'], dependencies, state: 'planned', max_attempts: 1, purpose: 'production', request_id: producer.request_id, intent_revision: producer.intent_revision }
  s.state.installPlan([work])
  return () => {
    s.state.createAttempt({ attempt_id: 'integrator-attempt', task_id: s.task, run_id: work.run_id, work_id: work.work_id, runtime_epoch: s.state.epoch, attempt_number: 1, profile_id: 'integrator-output-v1', model_config_id: 'production', model_config_revision: 1, input_versions: dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [], purpose: 'production', request_id: work.request_id, intent_revision: work.intent_revision })
    return s.store.executeRunnerProduction('integrator-attempt')
  }
}
function resourceCompletion(callId: string, value: unknown): Completion {
  return { text: '', calls: [{ id: callId, type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input: { display_name: callId, content: value } }) } }], finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 8 } }
}
function answerOnly(text: string): ProducerResult {
  return { version: 1, complete: true, answer: text, artifacts: [], requirement_ids: ['answer'], unresolved: [] }
}

it('corrects a missing artifact in the same host conversation and reuses the successful bundle', async () => {
  const s = setup({ productionRuns: 1, collator: 'rule' })
  let resourceId = '', proposed: ProducerResult | undefined
  s.complete.mockResolvedValueOnce(resourceCompletion('delivery-bundle', { type: 'json', value: content('Content to deliver') }))
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    const created = JSON.parse(messages.find(message => message.tool_call_id === 'delivery-bundle')!.content!)
    expect(created).toMatchObject({ execution: 'success', delivery: 'delivered' })
    resourceId = created.data.id
    proposed = provenanceResult(s, resourceId, created.provenance_ref, 'delivery-corrected-candidate')
    return answer(JSON.stringify(answerOnly('Content is ready.')))
  })
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    expect(messages[0]!.content).toContain('RUNNER_DELIVERY_MISSING')
    expect(messages.some(message => message.role === 'assistant' && message.content?.includes('Content is ready.'))).toBe(true)
    expect(JSON.parse(messages.find(message => message.tool_call_id === 'delivery-bundle')!.content!).data.id).toBe(resourceId)
    expect(s.records('worker.result')).toEqual([])
    expect(s.records('runner.answer')).toEqual([])
    expect(s.db.prepare('SELECT count(*) n FROM runner_work_outputs').get()).toEqual({ n: 0 })
    expect(s.db.prepare('SELECT count(*) n FROM runner_contribution_inventories').get()).toEqual({ n: 0 })
    return answer(JSON.stringify(proposed))
  })
  const run = s.store.start(s.task, 'Create and deliver one artifact', 'production', [])
  await vi.waitFor(() => expect(s.state.run(run).state).toBe('completed'))
  expect(s.complete).toHaveBeenCalledTimes(3)
  expect(s.records('resource.created')).toHaveLength(1)
  expect(s.records('worker.result.rejected')).toMatchObject([{ code: 'RUNNER_DELIVERY_MISSING', path: 'artifacts', value: [] }])
  expect(s.records('worker.result')).toMatchObject([{ value: proposed }])
  expect(s.records('runner.answer')).toMatchObject([{ text: proposed!.answer }])
  expect(s.records('runner.output.accepted')[0]!.artifacts).toEqual([{ task_id: s.task, artifact_id: 'provenance-artifact', artifact_revision: 1 }])
})

it('rejects direct acceptance of an empty delivery after a successful exact-owner bundle action', async () => {
  const s = setup({ productionRuns: 1, collator: 'rule' }), pending = deferred<Completion>()
  s.complete.mockImplementationOnce(() => pending.promise)
  const run = s.store.start(s.task, 'Verify final delivery at acceptance', 'production', [])
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(1))
  try {
    const owner = s.records('worker.input')[0]!.owner
    const created = await s.store.workerTool(owner.attempt_id, modelToolRequest('write', { operation: 'resource.create', input: { display_name: 'Direct delivery', content: { type: 'json', value: content('Undeclared delivery') } } }), new AbortController().signal)
    expect(created).toMatchObject({ execution: 'success', delivery: 'delivered' })
    const value = answerOnly('Content is ready.')
    const internal = s.store as unknown as { record(taskId: string, kind: string, payload: unknown): string }
    const resultRecordId = internal.record(s.task, 'worker.result', { value, run_id: run, owner })
    s.state.updateAttempt({ ...s.state.attempt(owner.attempt_id), state: 'succeeded', result_ref: { task_id: s.task, kind: 'record', id: resultRecordId } })
    const host = new RunnerHostProduction(s.db, s.state.epoch), validate = vi.fn()
    expect(() => host.accept(value, owner, validate)).toThrow(expect.objectContaining({ code: 'RUNNER_DELIVERY_MISSING' }))
    expect(validate).not.toHaveBeenCalled()
    expect(s.db.prepare('SELECT count(*) n FROM runner_work_outputs').get()).toEqual({ n: 0 })
    expect(s.db.prepare('SELECT count(*) n FROM runner_contribution_inventories').get()).toEqual({ n: 0 })
    expect(s.records('runner.answer')).toEqual([])
    expect(s.records('runner.output.accepted')).toEqual([])
  } finally {
    s.store.close()
    pending.resolve(answer('Discarded paused response'))
  }
})

it.each(['ordinary answer', 'text resource', 'ordinary JSON resource', 'failed managed bundle'] as const)('accepts an answer after %s without creating an artifact obligation', async mode => {
  const s = setup({ productionRuns: 1, collator: 'rule' })
  s.complete.mockRejectedValue(new Error('Unexpected model request after the final response'))
  if (mode === 'ordinary answer') s.complete.mockResolvedValueOnce(answer('A direct answer.'))
  else {
    const missingImage = content('No valid image')
    missingImage.html = '<section><img src="pliuna-resource:missing" alt="Missing image"></section>'
    missingImage.references = [{ name: 'missing', target: { kind: 'resource', id: 'missing-image-resource' } }]
    const resourceContent = mode === 'text resource' ? { type: 'text', text: 'Working notes' } : { type: 'json', value: mode === 'failed managed bundle' ? missingImage : { note: 'Working notes' } }
    s.complete.mockResolvedValueOnce(resourceCompletion('answer-resource', resourceContent))
    s.complete.mockImplementationOnce(async (_config, _key, messages) => {
      const result = JSON.parse(messages.find(message => message.tool_call_id === 'answer-resource')!.content!)
      expect(result).toMatchObject(mode === 'failed managed bundle' ? { execution: 'not_executed', error: { code: 'RESOURCE_MISSING' } } : { execution: 'success', delivery: 'delivered' })
      return answer(JSON.stringify(answerOnly('A direct answer.')))
    })
  }
  const run = s.store.start(s.task, 'Answer the current question', 'production', [])
  await vi.waitFor(() => expect(s.state.run(run).state).toBe('completed'))
  expect(s.complete).toHaveBeenCalledTimes(mode === 'ordinary answer' ? 1 : 2)
  expect(s.records('worker.result.rejected')).toEqual([])
  expect(s.records('runner.output.accepted')).toMatchObject([{ artifacts: [], requirement_ids: ['answer'] }])
  expect(s.records('runner.answer')).toHaveLength(1)
  if (mode === 'failed managed bundle') {
    expect(s.records('resource.created')).toEqual([])
    expect(s.db.prepare("SELECT state,result FROM actions WHERE json_extract(request_json,'$.display_name')='answer-resource'").get()).toEqual({ state: 'ended', result: 'not_executed' })
  }
})

it('keeps an explicit unresolved delivery partial after a successful bundle action', async () => {
  const s = setup({ productionRuns: 1, collator: 'rule' })
  s.complete.mockResolvedValueOnce(resourceCompletion('unresolved-bundle', { type: 'json', value: content('Unfinished delivery') }))
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    expect(JSON.parse(messages.find(message => message.tool_call_id === 'unresolved-bundle')!.content!)).toMatchObject({ execution: 'success' })
    const work = s.state.taskWorks(s.task)[0]!
    if (work.purpose !== 'production') throw Error('Expected producer')
    return answer(JSON.stringify({ ...answerOnly('The delivery remains unfinished.'), requirement_ids: [], unresolved: [{ task_id: s.task, request_id: work.request_id, intent_revision: work.intent_revision, requirement_id: 'answer' }] }))
  })
  const run = s.store.start(s.task, 'Keep an incomplete delivery explicit', 'production', [])
  await vi.waitFor(() => expect(s.state.run(run).state).toBe('completed'))
  expect(s.complete).toHaveBeenCalledTimes(2)
  expect(s.records('worker.result.rejected')).toEqual([])
  expect(s.records('runner.output.accepted')).toMatchObject([{ artifacts: [], requirement_ids: [] }])
  const work = s.state.taskWorks(s.task)[0]!
  if (work.purpose !== 'production') throw Error('Expected producer')
  const composition = new RunnerCompositionState(s.db, s.state, new RunnerArtifactState(s.db, s.state))
  expect(composition.inventory(s.task, work.request_id, work.intent_revision)).toMatchObject({ requirement_ids: [], unresolved: [{ requirement_id: 'answer' }] })
  expect(s.store.runnerGoals({ task_id: s.task })).toMatchObject({ goals: [{ delivery: 'incomplete', unresolved_count: 1 }], scope: { state: 'partial' } })
})

it('does not impose one active producer bundle on a sibling goal', async () => {
  const s = setup({ productionRuns: 2, collator: 'rule' }), pending = deferred<Completion>(), ready = deferred<void>()
  let resourceId = '', source: ArtifactCandidate['provenance_ref'] | undefined
  s.complete.mockResolvedValueOnce(resourceCompletion('sibling-bundle', { type: 'json', value: content('Sibling output') }))
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    const result = JSON.parse(messages.find(message => message.tool_call_id === 'sibling-bundle')!.content!)
    expect(result).toMatchObject({ execution: 'success', delivery: 'delivered' })
    resourceId = result.data.id; source = result.provenance_ref; ready.resolve()
    return pending.promise
  })
  const first = s.store.start(s.task, 'Create an artifact for the first goal', 'production', [])
  await ready.promise
  s.complete.mockResolvedValueOnce(answer(JSON.stringify(answerOnly('Independent sibling answer.'))))
  const second = s.store.start(s.task, 'Answer the second goal', 'production', [])
  await vi.waitFor(() => expect(s.state.run(second).state).toBe('completed'))
  expect(s.records('runner.answer')).toMatchObject([{ text: 'Independent sibling answer.', owner: { run_id: second } }])
  expect(s.records('worker.result.rejected')).toEqual([])
  pending.resolve(answer(JSON.stringify(provenanceResult(s, resourceId, source!, 'sibling-source-candidate'))))
  await vi.waitFor(() => expect(s.state.run(first).state).toBe('completed'))
  expect(s.complete).toHaveBeenCalledTimes(3)
  expect(s.records('runner.output.accepted')).toHaveLength(2)
  expect(s.records('resource.created')).toHaveLength(1)
})

it.each(['attempt_id', 'work_id', 'request_id'] as const)('ignores a successful bundle action bound to another %s', async field => {
  const s = setup({ productionRuns: 1, collator: 'rule' })
  s.complete.mockResolvedValueOnce(resourceCompletion('historical-bundle', { type: 'json', value: content('Historical output') }))
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    const result = JSON.parse(messages.find(message => message.tool_call_id === 'historical-bundle')!.content!)
    expect(result).toMatchObject({ execution: 'success', delivery: 'delivered' })
    const row = s.db.prepare('SELECT source_json FROM actions WHERE id=?').get(result.operation_id) as { source_json: string }
    const source = JSON.parse(row.source_json)
    source.owner[field] = `previous-${field}`
    s.db.prepare('UPDATE actions SET source_json=? WHERE id=?').run(JSON.stringify(source), result.operation_id)
    return answer(JSON.stringify(answerOnly('Only the current work is complete.')))
  })
  const run = s.store.start(s.task, 'Answer from the current attempt', 'production', [])
  await vi.waitFor(() => expect(s.state.run(run).state).toBe('completed'))
  expect(s.complete).toHaveBeenCalledTimes(2)
  expect(s.records('worker.result.rejected')).toEqual([])
  expect(s.records('runner.output.accepted')).toMatchObject([{ artifacts: [], requirement_ids: ['answer'] }])
})

it('persists independent final answers, exact complete outputs and seals before production closes', async () => {
  const s = setup(), pending = [deferred<Completion>(), deferred<Completion>()]
  let calls = 0
  s.complete.mockImplementation(async () => pending[calls++]!.promise)
  const alpha = s.store.start(s.task, 'Goal alpha', 'production', [])
  const beta = s.store.start(s.task, 'Goal beta', 'production', [])
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(2))
  expect(s.state.taskWorks(s.task).map(work => work.run_id)).toEqual([alpha, beta])
  pending[0]!.resolve(answer('Alpha final answer'))
  await vi.waitFor(() => expect(s.state.run(alpha).state).toBe('completed'))
  expect(s.state.run(beta).commit_valid).toBe(true)
  expect(s.records('runner.answer')).toMatchObject([{ text: 'Alpha final answer', purpose: 'final_answer', request_id: s.request(alpha), owner: { run_id: alpha, role: 'producer' } }])
  expect(s.db.prepare('SELECT COUNT(*) n FROM runner_work_outputs').get()).toEqual({ n: 1 })
  expect(s.db.prepare('SELECT COUNT(*) n FROM runner_contribution_inventories').get()).toEqual({ n: 1 })
  pending[1]!.resolve(answer('Beta final answer'))
  await vi.waitFor(() => expect(s.state.run(beta).state).toBe('completed'))
  expect(s.records('runner.answer').map(record => record.text)).toEqual(['Alpha final answer', 'Beta final answer'])
  expect(s.records('runner.output.accepted')).toHaveLength(2)
  expect(s.db.prepare('SELECT COUNT(DISTINCT budget_id) n FROM runner_runs').get()).toEqual({ n: 2 })
})

it('lets a Producer discover and read an enabled plugin workflow through its actual tools', async () => {
  const s = setup({ productionRuns: 1, collator: 'rule' }), source = mkdtempSync(join(tmpdir(), 'pliuna-worker-plugin-'))
  const text = 'Use the selected workflow to organize the response.'
  try {
    writeFileSync(join(source, 'workflow.md'), text)
    writeFileSync(join(source, 'manifest.json'), JSON.stringify({ manifest_version: '0.1', protocol_version: '0.1', id: 'fixture.worker-content', version: '1.0.0', access_level: 'task', contributes: [{ id: 'workflow', kind: 'workflow', entry: 'workflow.md', description: 'Worker workflow' }] }))
    const plugins = (s.store as unknown as { plugins: PluginControl }).plugins, copy = await plugins.install(source)
    const plan = plugins.plan(s.task, copy.digest)
    await plugins.enable(s.task, copy.digest, [], plan.fingerprint, false, () => {})
    plugins.selectWorkflow(s.task, { digest: copy.digest, contribution_id: 'workflow' }, () => {})
    let discovered = ''
    s.complete.mockResolvedValueOnce({ text: '', finish: 'tool_calls', calls: [{ id: 'list-plugins', type: 'function', function: { name: 'list', arguments: JSON.stringify({ kind: 'plugin' }) } }] })
    s.complete.mockImplementationOnce(async (_config, _key, messages) => {
      const result = JSON.parse(messages.at(-1)!.content!)
      expect(result).toMatchObject({ execution: 'success', data: { items: [{ enabled: true }] } })
      const selected = result.data.items[0].workflow
      expect(selected).toMatchObject({ kind: 'plugin' })
      discovered = selected.id
      return { text: '', finish: 'tool_calls', calls: [{ id: 'read-workflow', type: 'function', function: { name: 'read', arguments: JSON.stringify(selected) } }] }
    })
    s.complete.mockImplementationOnce(async (_config, _key, messages) => {
      expect(JSON.parse(messages.at(-1)!.content!)).toMatchObject({ execution: 'success', data: { data: { text } } })
      return answer('The enabled workflow was read.')
    })
    const run = s.store.start(s.task, 'Follow the enabled workflow.', 'production', [])
    await vi.waitFor(() => expect(s.state.run(run).state).toBe('completed'))
    expect(discovered).toContain('plugin-content:' + copy.digest + ':')
    expect(s.complete).toHaveBeenCalledTimes(3)
  } finally { rmSync(source, { recursive: true, force: true }) }
})

it('corrects a request id used as provenance without recreating or prematurely accepting the bundle', async () => {
  const s = setup({ productionRuns: 1, collator: 'rule' })
  let bundleResource = '', rejected: ProducerResult | undefined, corrected: ProducerResult | undefined
  s.complete.mockResolvedValueOnce({ text: '', finish: 'tool_calls', calls: [{ id: 'create-provenance-bundle', type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input: { display_name: 'Artifact.json', content: { type: 'json', value: content('Reuse this bundle') } } }) } }] })
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    const result = JSON.parse(messages.at(-1)!.content!)
    expect(result).toMatchObject({ execution: 'success', data: { media_type: 'application/json' } })
    bundleResource = result.data.id
    const work = s.state.taskWorks(s.task)[0]!
    if (work.purpose !== 'production') throw Error('Expected producer')
    rejected = provenanceResult(s, bundleResource, { task_id: s.task, kind: 'record', id: work.request_id }, 'wrong-provenance')
    return answer(JSON.stringify(rejected))
  })
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    expect(s.records('worker.result')).toEqual([])
    expect(new RunnerArtifactState(s.db, s.state).candidate(s.task, 'wrong-provenance')).toBeNull()
    expect(new RunnerArtifactState(s.db, s.state).artifact(s.task, 'provenance-artifact')).toBeNull()
    const feedback = messages.filter(message => message.role !== 'assistant' && message.role !== 'tool').map(message => message.content ?? '').join('\n')
    expect(feedback).toContain('RUNNER_PROVENANCE_INVALID')
    expect(feedback).toContain('artifacts[0].provenance_ref')
    expect(feedback).toContain(rejected!.artifacts[0]!.provenance_ref.id)
    const retained = messages.find(message => message.role === 'tool' && message.tool_call_id === 'create-provenance-bundle')
    expect(JSON.parse(retained?.content ?? '{}')).toMatchObject({ execution: 'success', data: { id: bundleResource } })
    corrected = provenanceResult(s, bundleResource, { task_id: s.task, kind: 'resource', id: bundleResource }, 'corrected-provenance')
    return answer(JSON.stringify(corrected))
  })

  const run = s.store.start(s.task, 'Create one complete artifact', 'production', [])
  await vi.waitFor(() => expect(s.state.run(run).state).toBe('completed'))

  expect(s.complete).toHaveBeenCalledTimes(3)
  expect(s.records('resource.created')).toHaveLength(1)
  expect(s.records('worker.tool.ended')).toMatchObject([{ state: 'completed' }])
  expect(s.records('worker.result.rejected')).toMatchObject([{ code: 'RUNNER_PROVENANCE_INVALID', path: 'artifacts[0].provenance_ref', value: rejected!.artifacts[0]!.provenance_ref }])
  expect(s.records('worker.result')).toMatchObject([{ value: corrected }])
  expect(s.records('worker.ended')).toMatchObject([{ state: 'succeeded' }])
  expect(new RunnerArtifactState(s.db, s.state).artifact(s.task, 'provenance-artifact')).toMatchObject({ artifact_revision: 1, bundle_resource_id: bundleResource, provenance_ref: { task_id: s.task, kind: 'resource', id: bundleResource } })
})

it('rechecks provenance at acceptance and retains its rejection after the source becomes available again', async () => {
  const s = setup({ productionRuns: 1, collator: 'rule' }), otherTask = s.store.create('Other provenance task').task.id
  let sourceResource = '', proposed: ProducerResult | undefined, owner: Parameters<RunnerHostProduction['preflight']>[1] | undefined
  const originalPreflight = RunnerHostProduction.prototype.preflight
  const preflight = vi.spyOn(RunnerHostProduction.prototype, 'preflight').mockImplementation(function (this: RunnerHostProduction, raw, rawOwner, sources) {
    const issue = originalPreflight.call(this, raw, rawOwner, sources)
    expect(issue).toBeNull()
    owner = rawOwner
    expect(s.db.prepare('UPDATE task_resources SET task_id=? WHERE task_id=? AND resource_id=?').run(otherTask, s.task, sourceResource).changes).toBe(1)
    return issue
  })
  const write = (id: string, display_name: string, content: unknown): Completion['calls'][number] => ({ id, type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input: { display_name, content } }) } })
  s.complete.mockResolvedValueOnce({ text: '', finish: 'tool_calls', calls: [write('create-race-bundle', 'Artifact.json', { type: 'json', value: content('Source may disappear') }), write('create-race-source', 'Source.txt', { type: 'text', text: 'Original source' })] })
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    const bundleResult = JSON.parse(messages.find(message => message.tool_call_id === 'create-race-bundle')!.content!)
    const sourceResult = JSON.parse(messages.find(message => message.tool_call_id === 'create-race-source')!.content!)
    expect(bundleResult.execution).toBe('success')
    expect(sourceResult.execution).toBe('success')
    sourceResource = sourceResult.data.id
    proposed = provenanceResult(s, bundleResult.data.id, { task_id: s.task, kind: 'resource', id: sourceResource }, 'raced-provenance')
    return answer(JSON.stringify(proposed))
  })

  const run = s.store.start(s.task, 'Create one complete artifact', 'production', [])
  await vi.waitFor(() => expect(s.state.run(run).state).toBe('failed'))

  expect(preflight).toHaveBeenCalledOnce()
  expect(s.complete).toHaveBeenCalledTimes(2)
  expect(s.records('worker.result.rejected')).toEqual([])
  expect(s.records('worker.result')).toMatchObject([{ value: proposed }])
  expect(s.records('worker.ended')).toMatchObject([{ state: 'failed', code: 'RUNNER_PROVENANCE_INVALID' }])
  const artifacts = new RunnerArtifactState(s.db, s.state), retained = artifacts.candidate(s.task, 'raced-provenance')
  expect(retained).toEqual({ candidate: proposed!.artifacts[0], result: { state: 'rejected', code: 'RUNNER_PROVENANCE_INVALID' } })
  expect(artifacts.owner(s.task, 'provenance-artifact')).toBeNull()
  expect(artifacts.artifact(s.task, 'provenance-artifact')).toBeNull()
  expect(s.db.prepare('UPDATE task_resources SET task_id=? WHERE task_id=? AND resource_id=?').run(s.task, otherTask, sourceResource).changes).toBe(1)
  expect(() => artifacts.checkProvenance(s.task, proposed!.artifacts[0]!.provenance_ref)).not.toThrow()
  if (!proposed || !owner) throw Error('Expected the original final result and owner')
  const host = new RunnerHostProduction(s.db, s.state.epoch), finalResult = proposed, finalOwner = owner
  expect(() => host.accept(finalResult, finalOwner, () => {})).toThrow(expect.objectContaining({ code: 'RUNNER_PROVENANCE_INVALID' }))
  expect(artifacts.candidate(s.task, 'raced-provenance')).toEqual(retained)
  expect(s.records('worker.result')).toMatchObject([{ value: proposed }])
})

it('lets a Producer discover contracts and create an accepted JSON bundle through its actual tools', async () => {
  const s = setup({ productionRuns: 2, collator: 'rule' })
  const tool = (id: string, name: string, input: unknown): Completion['calls'][number] => ({ id, type: 'function', function: { name, arguments: JSON.stringify(input) } })
  const calls = (...calls: Completion['calls']): Completion => ({ text: '', calls, finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 8 } })
  s.complete.mockResolvedValueOnce(calls(tool('discover-contracts', 'list', { kind: 'object_type', limit: 20 })))
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    expect(JSON.parse(messages.at(-1)!.content!)).toMatchObject({ execution: 'success', delivery: 'delivered' })
    return calls(
      tool('write-guide', 'read', { kind: 'object_type', id: 'tool.write', selection: { view: 'guide' } }),
      tool('resource-guide', 'read', { kind: 'object_type', id: 'resource.create', selection: { view: 'guide' } }),
      tool('bundle-schema', 'read', { kind: 'object_type', id: 'surface.update', selection: { view: 'schema', section: 'bundle' } }),
      tool('bundle-example', 'read', { kind: 'object_type', id: 'surface.update', selection: { view: 'example', section: 'view.create' } })
    )
  })
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    const results = messages.filter(message => message.role === 'tool').slice(-4).map(message => JSON.parse(message.content!))
    expect(results).toHaveLength(4)
    for (const result of results) expect(result).toMatchObject({ execution: 'success', delivery: 'delivered' })
    const example = results[3]!.data.data
    const bundle: Bundle = JSON.parse(example.input_json).operations[0].bundle.bundle
    expect(bundle.profile).toBe('managed-v1')
    bundle.html = '<section id="lesson"><p>Multi-armed bandit lecture</p></section>'
    return calls(tool('create-bundle', 'write', { operation: 'resource.create', input: { display_name: 'Bandit lecture.json', content: { type: 'json', value: bundle } } }))
  })
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    const result = JSON.parse(messages.at(-1)!.content!)
    expect(result).toMatchObject({ execution: 'success', data: { media_type: 'application/json' } })
    const work = s.state.taskWorks(s.task)[0]!
    if (work.purpose !== 'production') throw Error('Expected producer')
    const goal = s.state.goal(work.request_id), section = new RunnerArtifactState(s.db, s.state).outline(s.task)!.sections[0]!
    const candidate: ArtifactCandidate = { candidate_id: 'bandit-candidate', task_id: s.task, request_id: work.request_id, intent_revision: work.intent_revision, run_id: work.run_id, work_id: work.work_id, attempt_id: work.current_attempt_id!, artifact_id: 'bandit-lecture', base_artifact_revision: 0, plan_revision: work.plan_revision, bundle_resource_id: result.data.id, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key, presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: s.task, kind: 'record', id: s.state.input(goal.input_event_id).record_id }, requirement_ids: ['answer'], unresolved: [], dependencies: work.dependencies }
    return answer(JSON.stringify({ version: 1, complete: true, answer: 'Multi-armed bandit lecture is ready.', artifacts: [candidate], requirement_ids: ['answer'], unresolved: [] }))
  })
  const run = s.store.start(s.task, 'Generate a multi-armed bandit lecture', 'production', [])
  await vi.waitFor(() => expect(s.state.run(run).state).toBe('completed'))
  expect(s.complete).toHaveBeenCalledTimes(4)
  expect(s.records('model.tool_result')).toHaveLength(6)
  expect(s.records('worker.ended')).toMatchObject([{ state: 'succeeded' }])
  expect(s.records('runner.answer')).toMatchObject([{ text: 'Multi-armed bandit lecture is ready.' }])
  expect(s.records('runner.output.accepted')).toHaveLength(1)
  expect(new RunnerArtifactState(s.db, s.state).artifact(s.task, 'bandit-lecture')).toMatchObject({ artifact_revision: 1 })
})

it.each(['invalid raw draft', 'cross-task image'] as const)('returns %s bundle errors during resource creation and accepts a corrected tool round', async failure => {
  const s = setup({ productionRuns: 2, collator: 'rule' }), invalid = content('Corrected artifact')
  let expectedError = { code: 'UNSUPPORTED_BUNDLE', message: 'Invalid raw draft types' }
  if (failure === 'invalid raw draft') {
    invalid.html = '<section><p id="count">Completed items</p></section>'
    invalid.state.schema.properties = { doneCount: { type: 'integer' } }
    invalid.state.initial = { doneCount: 0 }
    invalid.behaviors = [{ type: 'text', element_id: 'count', field: '/doneCount' }]
  } else {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z1sAAAAASUVORK5CYII=', 'base64')
    const importImage = (task_id: string): string => {
      const registered = s.store.handle({ type: 'material.internal.register', task_id, items: [{ display_name: 'pixel.png', source: 'file' }] }) as { items: { operation_id: string }[] }
      const operation_id = registered.items[0]!.operation_id
      s.store.handle({ type: 'material.internal.begin', task_id, operation_id, byte_length: png.length, media_type: 'application/octet-stream' })
      s.store.handle({ type: 'material.internal.chunk', task_id, operation_id, offset: 0, data: png.toString('base64') })
      const resource = (s.store.handle({ type: 'material.internal.finish', task_id, operation_id }) as { resource: { id: string } }).resource
      s.db.prepare('UPDATE resources SET media_type=? WHERE id=?').run('image/png', resource.id)
      return resource.id
    }
    invalid.html = '<section><img src="pliuna-resource:picture" alt="One pixel"></section>'
    invalid.references = [{ name: 'picture', target: { kind: 'resource', id: importImage(s.store.create('Other task').task.id) } }]
    expectedError = { code: 'RESOURCE_MISSING', message: 'View resource is unavailable in this task' }
    const corrected = structuredClone(invalid)
    corrected.references[0]!.target.id = importImage(s.task)
    return runRecovery(corrected)
  }
  const corrected = structuredClone(invalid)
  corrected.state.initial = { doneCount: '0' }
  return runRecovery(corrected)

  async function runRecovery(corrected: Bundle) {
    const initialResources = s.db.prepare('SELECT COUNT(*) n FROM resources').get(), initialStages = s.db.prepare('SELECT COUNT(*) n FROM staging').get()
    const create = (id: string, bundle: Bundle): Completion => ({ text: '', calls: [{ id, type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input: { display_name: 'Artifact.json', content: { type: 'json', value: bundle } } }) } }], finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 8 } })
    s.complete.mockResolvedValueOnce(create('invalid-bundle', invalid))
    s.complete.mockImplementationOnce(async (_config, _key, messages) => {
      expect(JSON.parse(messages.at(-1)!.content!)).toMatchObject({ execution: 'not_executed', error: expectedError })
      expect(s.db.prepare('SELECT COUNT(*) n FROM resources').get()).toEqual(initialResources)
      expect(s.db.prepare('SELECT COUNT(*) n FROM staging').get()).toEqual(initialStages)
      expect(s.records('resource.created')).toEqual([])
      expect(s.db.prepare("SELECT state,result,commit_valid,json_extract(result_json,'$.code') code FROM actions WHERE json_extract(request_json,'$.display_name')='Artifact.json'").get()).toEqual({ state: 'ended', result: 'not_executed', commit_valid: 0, code: expectedError.code })
      return create('corrected-bundle', corrected)
    })
    s.complete.mockImplementationOnce(async (_config, _key, messages) => {
      const result = JSON.parse(messages.at(-1)!.content!)
      expect(result).toMatchObject({ execution: 'success', data: { media_type: 'application/json' } })
      const work = s.state.taskWorks(s.task)[0]!
      if (work.purpose !== 'production') throw Error('Expected producer')
      const goal = s.state.goal(work.request_id), section = new RunnerArtifactState(s.db, s.state).outline(s.task)!.sections[0]!
      const candidate: ArtifactCandidate = { candidate_id: 'corrected-candidate', task_id: s.task, request_id: work.request_id, intent_revision: work.intent_revision, run_id: work.run_id, work_id: work.work_id, attempt_id: work.current_attempt_id!, artifact_id: 'corrected-artifact', base_artifact_revision: 0, plan_revision: work.plan_revision, bundle_resource_id: result.data.id, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key, presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: s.task, kind: 'record', id: s.state.input(goal.input_event_id).record_id }, requirement_ids: ['answer'], unresolved: [], dependencies: work.dependencies }
      return answer(JSON.stringify({ version: 1, complete: true, answer: 'Corrected artifact is ready.', artifacts: [candidate], requirement_ids: ['answer'], unresolved: [] }))
    })
    const run = s.store.start(s.task, 'Create one complete artifact', 'production', [])
    await vi.waitFor(() => expect(s.state.run(run).state).toBe('completed'))
    expect(s.complete).toHaveBeenCalledTimes(3)
    expect(s.records('resource.created')).toHaveLength(1)
    expect(s.records('worker.tool.ended')).toMatchObject([{ state: 'failed', code: expectedError.code }, { state: 'completed' }])
    expect(s.records('worker.ended')).toMatchObject([{ state: 'succeeded' }])
    expect(new RunnerArtifactState(s.db, s.state).artifact(s.task, 'corrected-artifact')).toMatchObject({ artifact_revision: 1 })
    await vi.waitFor(() => expect(s.store.snapshot(s.task).approvals.find(item => item.decision === 'pending' && item.validity === 'valid')).toBeDefined())
    const approval = s.store.snapshot(s.task).approvals.find(item => item.decision === 'pending' && item.validity === 'valid')!
    s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: approval.id, decision: 'approve' })
    await vi.waitFor(() => expect(s.store.snapshot(s.task).surface_updates.find(item => item.action_id === approval.action_id)).toBeDefined())
    await s.store.handle({ type: 'surface.respond', task_id: s.task, action_id: approval.action_id, proceed: true, confirm_discard: false })
    await vi.waitFor(() => expect(s.store.snapshot(s.task).views).toHaveLength(1))
    if (failure === 'cross-task image') expect(s.store.snapshot(s.task).views[0]!.presentation.html).toContain('src="data:image/png;base64,')
  }
})

it('keeps ordinary JSON resource creation available to production workers', async () => {
  const s = setup({ productionRuns: 2, collator: 'rule' })
  s.complete.mockResolvedValueOnce({ text: '', calls: [{ id: 'ordinary-json', type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input: { display_name: 'Progress.json', content: { type: 'json', value: { doneCount: 0, profile: 'progress' } } } }) } }], finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 8 } })
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    expect(JSON.parse(messages.at(-1)!.content!)).toMatchObject({ execution: 'success', data: { media_type: 'application/json' } })
    return answer('Progress data is saved.')
  })
  const run = s.store.start(s.task, 'Save ordinary progress data', 'production', [])
  await vi.waitFor(() => expect(s.state.run(run).state).toBe('completed'))
  expect(s.complete).toHaveBeenCalledTimes(2)
  expect(s.records('resource.created')).toHaveLength(1)
  expect(s.records('worker.ended')).toMatchObject([{ state: 'succeeded' }])
})

it.each(['missing answer', 'text bundle'] as const)('still rejects a Producer result with %s', async failure => {
  const s = setup({ productionRuns: 2, collator: 'rule' })
  let invalidResult: Completion
  s.complete.mockResolvedValueOnce({ text: '', calls: [{ id: 'create-output', type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input_json: JSON.stringify({ display_name: 'Lecture', content: failure === 'text bundle' ? { type: 'text', text: '# Multi-armed bandits' } : { type: 'json', value: content('Multi-armed bandits') } }) }) } }], finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 8 } })
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    const resource = JSON.parse(messages.at(-1)!.content!).data.id, work = s.state.taskWorks(s.task)[0]!
    if (work.purpose !== 'production') throw Error('Expected producer')
    const goal = s.state.goal(work.request_id), section = new RunnerArtifactState(s.db, s.state).outline(s.task)!.sections[0]!
    const candidate: ArtifactCandidate = { candidate_id: 'invalid-candidate', task_id: s.task, request_id: work.request_id, intent_revision: work.intent_revision, run_id: work.run_id, work_id: work.work_id, attempt_id: work.current_attempt_id!, artifact_id: 'invalid-lecture', base_artifact_revision: 0, plan_revision: work.plan_revision, bundle_resource_id: resource, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key, presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: s.task, kind: 'record', id: s.state.input(goal.input_event_id).record_id }, requirement_ids: ['answer'], unresolved: [], dependencies: work.dependencies }
    invalidResult = answer(JSON.stringify({ version: 1, complete: true, answer: failure === 'missing answer' ? null : 'Lecture is ready.', artifacts: [candidate], requirement_ids: ['answer'], unresolved: [] }))
    return invalidResult
  })
  s.complete.mockImplementationOnce(async () => invalidResult)
  const run = s.store.start(s.task, 'Reject an invalid lecture result', 'production', [])
  await vi.waitFor(() => expect(s.state.run(run).state).toBe('failed'))
  expect(s.complete).toHaveBeenCalledTimes(failure === 'missing answer' ? 3 : 2)
  expect(s.records('worker.result.rejected')).toHaveLength(failure === 'missing answer' ? 1 : 0)
  expect(s.records('worker.ended')).toMatchObject([{ state: 'failed', code: failure === 'missing answer' ? 'INVALID_WORKER_RESULT' : 'INVALID_BUNDLE_SOURCE' }])
  expect(s.records('runner.output.accepted')).toEqual([])
  expect(new RunnerArtifactState(s.db, s.state).artifact(s.task, 'invalid-lecture')).toBeNull()
})

it('ends repeated invalid JSON tool input without locking a production slot on unknown usage', async () => {
  const s = setup({ productionRuns: 1, collator: 'rule' })
  const invalidWrite = (id: string): Completion => ({ text: '', calls: [{ id, type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input_json: '{"display_name":"Lecture","content":' }) } }], finish: 'tool_calls' })
  s.complete.mockResolvedValueOnce(invalidWrite('invalid-first'))
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    expect(JSON.parse(messages.at(-1)!.content!)).toMatchObject({ execution: 'not_executed', error: { code: 'INVALID_REQUEST' } })
    return invalidWrite('invalid-second')
  })
  s.complete.mockRejectedValue(new Error('Repeated invalid input must end before another request'))
  const run = s.store.start(s.task, 'Create a formatted lecture', 'production', [])
  await vi.waitFor(() => expect(s.state.run(run).state).toBe('failed'))
  expect(s.complete).toHaveBeenCalledTimes(2)
  expect(s.records('worker.ended')).toMatchObject([{ state: 'failed', code: 'MODEL_TOOL_NO_PROGRESS' }])
  expect(s.records('model.tool_result').map(record => JSON.parse(record.message.content))).toMatchObject([
    { execution: 'not_executed', error: { code: 'INVALID_REQUEST' } },
    { execution: 'not_executed', error: { code: 'INVALID_REQUEST' } }
  ])
  expect(s.records('runner.output.accepted')).toEqual([])
  expect(s.store.snapshot(s.task)).toMatchObject({ views: [], runs: [expect.objectContaining({ id: run, state: 'failed', primary_reason: 'MODEL_TOOL_NO_PROGRESS', wait_reason: null })] })
  expect(s.db.prepare('SELECT state,usage_json FROM runner_budget_reservations ORDER BY rowid').all()).toEqual([{ state: 'unknown', usage_json: null }, { state: 'unknown', usage_json: null }])
  expect(s.release).toHaveBeenCalledOnce()
  s.complete.mockResolvedValue({ text: 'The next request can complete.', calls: [], finish: 'stop' })
  const next = s.store.start(s.task, 'Answer a fresh request', 'production', [])
  await vi.waitFor(() => expect(s.state.run(next).state).toBe('completed'))
  expect(s.records('runner.answer')).toMatchObject([{ text: 'The next request can complete.' }])
})

it('bounds the controlled dual producer path and admits a later goal after closing releases its slot', async () => {
  const s = setup(), pending = deferred<Completion>()
  s.complete.mockImplementation(async () => pending.promise)
  const first = s.store.start(s.task, 'First', 'production', [])
  const second = s.store.start(s.task, 'Second', 'production', [])
  expect(() => s.store.start(s.task, 'Third', 'production', [])).toThrow(expect.objectContaining({ code: 'RUN_BUSY' }))
  expect(s.db.prepare('SELECT COUNT(*) n FROM runner_runs').get()).toEqual({ n: 2 })
  pending.resolve(answer('finished'))
  await vi.waitFor(() => expect([s.state.run(first).state, s.state.run(second).state]).toEqual(['completed', 'completed']))
  s.complete.mockResolvedValue(answer('third'))
  const third = s.store.start(s.task, 'Third', 'production', [])
  await vi.waitFor(() => expect(s.state.run(third).state).toBe('completed'))
  expect(s.records('runner.answer')).toHaveLength(3)
})

it('keeps the default compatibility path single producer after controlled execution ends', async () => {
  const s = setup(null), pending = deferred<Completion>()
  s.complete.mockImplementation(async () => pending.promise)
  const run = s.store.start(s.task, 'Default goal', 'production', [])
  expect(() => s.store.start(s.task, 'Another default goal', 'production', [])).toThrow(expect.objectContaining({ code: 'RUN_BUSY' }))
  expect(s.db.prepare('SELECT COUNT(*) n FROM runner_runs').get()).toEqual({ n: 0 })
  pending.resolve(answer('legacy final'))
  await vi.waitFor(() => expect((s.db.prepare('SELECT state FROM runs WHERE id=?').get(run) as { state: string }).state).toBe('completed'))
  expect(s.records('message.assistant').at(-1)?.text).toBe('legacy final')
})

it('returns the exact installed production receipt after the source ended without resealing inventories', async () => {
  const s = setup(); s.complete.mockResolvedValue(answer('One final answer'))
  const run = s.store.start(s.task, 'Publish one exact result', 'production', [])
  await vi.waitFor(() => expect(s.state.run(run).state).toBe('completed'))
  const record = s.records('worker.result')[0]!, host = new RunnerHostProduction(s.db, s.state.epoch), validate = vi.fn()
  const first = host.accept(record.value, record.owner, validate), next = host.accept(structuredClone(record.value), structuredClone(record.owner), validate)
  expect(next).toEqual(first)
  expect(first.inventory?.inventory_revision).toBe(1)
  expect(validate).not.toHaveBeenCalled()
  expect(s.db.prepare('SELECT count(*) n FROM runner_work_outputs').get()).toEqual({ n: 1 })
  expect(s.db.prepare('SELECT count(*) n FROM runner_contribution_inventories').get()).toEqual({ n: 1 })
  expect(() => host.accept({ ...record.value, answer: 'Changed payload' }, record.owner, validate)).toThrow(expect.objectContaining({ code: 'RUNNER_OUTPUT_CONFLICT' }))
})

it('retains a precise rejected candidate after outer installation rollback and preserves the old pointer', async () => {
  const s = setup(), artifacts = new RunnerArtifactState(s.db, s.state)
  let original: ArtifactCandidate
  s.complete.mockImplementation(async () => {
    const work = s.state.taskWorks(s.task)[0]!
    if (work.purpose !== 'production') throw Error('Expected producer')
    const goal = s.state.goal(work.request_id), section = artifacts.outline(s.task)!.sections[0]!
    const content: Bundle = { profile: 'managed-v1', html: '<section><p>Accepted source</p></section>', css: '', state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'v1' }, forms: [], behaviors: [], references: [], export: [] }
    const resource = (s.store.modelTool(s.task, work.run_id, { type: 'write', input: { type: 'resource.create', display_name: 'Source', content: { type: 'json', value: content } } }) as { data: { id: string } }).data.id
    const candidate = (artifactId: string, candidateId: string): ArtifactCandidate => ({ candidate_id: candidateId, task_id: s.task, request_id: work.request_id, intent_revision: work.intent_revision, run_id: work.run_id, work_id: work.work_id, attempt_id: work.current_attempt_id!, artifact_id: artifactId, base_artifact_revision: 0, plan_revision: work.plan_revision, bundle_resource_id: resource, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key, presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: s.task, kind: 'record', id: s.state.input(goal.input_event_id).record_id }, requirement_ids: ['answer'], unresolved: [], dependencies: work.dependencies })
    original = candidate('stable-artifact', 'original-accepted')
    artifacts.assign([{ task_id: s.task, artifact_id: original.artifact_id, section_id: original.section_id, work_id: work.work_id, plan_revision: work.plan_revision, base_artifact_revision: 0 }])
    expect(artifacts.decide(original, { state: 'accepted' }).state).toBe('accepted')
    const result: ProducerResult = { version: 1, complete: true, answer: 'Result with a stale fragment', artifacts: [candidate('new-fragment', 'rolled-back-fragment'), candidate('stable-artifact', 'rejected-stale-fragment')], requirement_ids: ['answer'], unresolved: [] }
    return answer(JSON.stringify(result))
  })
  const run = s.store.start(s.task, 'Accept exact candidates atomically', 'production', [])
  await vi.waitFor(() => expect(s.state.run(run).state).toBe('failed'))
  expect(artifacts.candidate(s.task, 'rolled-back-fragment')).toBeNull()
  expect(artifacts.owner(s.task, 'new-fragment')).toBeNull()
  expect(artifacts.candidate(s.task, 'rejected-stale-fragment')).toMatchObject({ result: { state: 'rejected', code: 'RUNNER_ARTIFACT_CONFLICT' } })
  expect(artifacts.artifact(s.task, 'stable-artifact')).toMatchObject({ artifact_revision: 1, bundle_resource_id: original!.bundle_resource_id })
  expect(s.db.prepare('SELECT count(*) n FROM runner_work_outputs').get()).toEqual({ n: 0 })
  const record = s.records('worker.result')[0]!, host = new RunnerHostProduction(s.db, s.state.epoch), validate = vi.fn()
  expect(() => host.accept(record.value, record.owner, validate)).toThrow(expect.objectContaining({ code: 'RUNNER_ARTIFACT_CONFLICT' }))
  expect(validate).not.toHaveBeenCalled()
  expect(artifacts.artifact(s.task, 'stable-artifact')?.artifact_revision).toBe(1)
  expect(s.records('runner.output.accepted')).toEqual([])
})

it('integrates an exact complete work output and seals with the original designated source before closing', async () => {
  const s = setup(), pending = deferred<Completion>()
  s.complete.mockImplementationOnce(() => pending.promise)
  const run = s.store.start(s.task, 'Reconcile the source', 'production', [])
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(1))
  const producer = s.state.taskWorks(s.task)[0]!
  if (producer.purpose !== 'production') throw Error('Expected producer')
  const artifacts = new RunnerArtifactState(s.db, s.state), composition = new RunnerCompositionState(s.db, s.state, artifacts), goal = s.state.goal(producer.request_id), section = artifacts.outline(s.task)!.sections[0]!
  const resource = (s.store.modelTool(s.task, run, { type: 'write', input: { type: 'resource.create', display_name: 'Declared source', content: { type: 'json', value: content('DECLARED_SOURCE_BODY') } } }) as { data: { id: string } }).data.id
  const unrelated = (s.store.modelTool(s.task, run, { type: 'write', input: { type: 'resource.create', display_name: 'Unrelated source', content: { type: 'text', text: 'UNRELATED_PRIVATE_BODY' } } }) as { data: { id: string } }).data.id
  const candidate: ArtifactCandidate = { candidate_id: 'source-candidate', task_id: s.task, request_id: producer.request_id, intent_revision: producer.intent_revision, run_id: run, work_id: producer.work_id, attempt_id: producer.current_attempt_id!, artifact_id: 'source-artifact', base_artifact_revision: 0, plan_revision: 1, bundle_resource_id: resource, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key, presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: s.task, kind: 'record', id: s.state.input(goal.input_event_id).record_id }, requirement_ids: ['answer'], unresolved: [], dependencies: producer.dependencies }
  const execute = integration(s, producer, [{ kind: 'work', task_id: s.task, work_id: producer.work_id, result_revision: 1 }])
  pending.resolve(answer(JSON.stringify({ version: 1, complete: true, answer: 'Source answer', artifacts: [candidate], requirement_ids: ['answer'], unresolved: [] })))
  await vi.waitFor(() => expect(s.state.work(producer.work_id).state).toBe('succeeded'))
  expect(s.state.run(run).commit_valid).toBe(true)
  expect(composition.inventory(s.task, producer.request_id, 1)).toBeNull()
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    const input = JSON.stringify(messages)
    expect(input).toContain(resource)
    expect(input).toContain('source-artifact')
    expect(input).not.toContain('DECLARED_SOURCE_BODY')
    expect(input).not.toContain(unrelated)
    return { text: '', calls: [{ id: 'read-declared-source', type: 'function', function: { name: 'read', arguments: JSON.stringify({ kind: 'resource', id: resource }) } }], finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 8 } }
  })
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    expect(JSON.stringify(messages)).toContain('DECLARED_SOURCE_BODY')
    await expect(s.store.workerTool('integrator-attempt', modelToolRequest('read', { kind: 'resource', id: unrelated }), new AbortController().signal)).resolves.toMatchObject({ execution: 'success', data: { data: { text: 'UNRELATED_PRIVATE_BODY' } } })
    return answer('Integrated final answer')
  })
  expect((await execute()).answer).toBe('Integrated final answer')
  expect(s.state.run(run).state).toBe('completed')
  const inventory = composition.inventory(s.task, producer.request_id, 1)!
  expect(inventory.required_works.map(work => work.work_id)).toEqual([producer.work_id, 'integrator'])
  expect(inventory.required_works[0]!.artifacts).toEqual([{ task_id: s.task, artifact_id: candidate.artifact_id, artifact_revision: 1 }])
  expect(inventory.sealed_by).toEqual({ work_id: producer.work_id, plan_revision: 1, run_id: run, attempt_id: producer.current_attempt_id, role: 'producer' })
  expect(s.records('runner.output.accepted').at(-1)?.inventory_revision).toBe(1)
})

it('rejects an Integrator without explicit content inputs before any model dispatch', async () => {
  const s = setup(), pending = deferred<Completion>()
  s.complete.mockImplementationOnce(() => pending.promise)
  const run = s.store.start(s.task, 'Keep integration source-bound', 'production', [])
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(1))
  const producer = s.state.taskWorks(s.task)[0]!, execute = integration(s, producer, producer.dependencies)
  pending.resolve(answer('Source final answer'))
  await vi.waitFor(() => expect(s.state.work(producer.work_id).state).toBe('succeeded'))
  await expect(execute()).rejects.toMatchObject({ code: 'RUNNER_DEPENDENCY_INVALID' })
  expect(s.complete).toHaveBeenCalledTimes(1)
  expect(s.state.attempt('integrator-attempt').dispatch_state).toBe('not_dispatched')
  expect(s.state.run(run).commit_valid).toBe(true)
})

it('keeps completed integration unsealed when its designated planning source was revoked', async () => {
  const s = setup(), pending = deferred<Completion>()
  s.complete.mockImplementationOnce(() => pending.promise)
  const run = s.store.start(s.task, 'Retain the revoked planning source', 'production', [])
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(1))
  const producer = s.state.taskWorks(s.task)[0]!
  if (producer.purpose !== 'production') throw Error('Expected producer')
  const execute = integration(s, producer, [{ kind: 'work', task_id: s.task, work_id: producer.work_id, result_revision: 1 }]), artifacts = new RunnerArtifactState(s.db, s.state), composition = new RunnerCompositionState(s.db, s.state, artifacts)
  const router: LogicalWork = { task_id: s.task, run_id: run, work_id: 'designated-router', plan_revision: 1, role: 'router', required: false, requirement_ids: [], dependencies: producer.dependencies, state: 'planned', max_attempts: 1, purpose: 'production', request_id: producer.request_id, intent_revision: producer.intent_revision }
  s.state.installPlan([router])
  s.state.createAttempt({ attempt_id: 'router-attempt', task_id: s.task, run_id: run, work_id: router.work_id, runtime_epoch: s.state.epoch, attempt_number: 1, profile_id: 'router-outline-v1', model_config_id: 'production', model_config_revision: 1, input_versions: router.dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [], purpose: 'production', request_id: producer.request_id, intent_revision: 1 })
  composition.designateSource({ task_id: s.task, request_id: producer.request_id, intent_revision: 1, work_id: router.work_id, plan_revision: 1 }, { work_id: producer.work_id, plan_revision: 1 })
  s.state.revokeWork(router.work_id)
  pending.resolve(answer('Source final answer'))
  await vi.waitFor(() => expect(s.state.work(producer.work_id).state).toBe('succeeded'))
  s.complete.mockResolvedValueOnce(answer('Integrated answer'))
  expect((await execute()).answer).toBe('Integrated answer')
  expect(s.state.run(run).state).toBe('completed')
  expect(composition.inventory(s.task, producer.request_id, 1)).toBeNull()
  expect(s.state.attempt('router-attempt')).toMatchObject({ state: 'revoked', dispatch_state: 'not_dispatched' })
  expect(s.db.prepare('SELECT COUNT(*) n FROM runner_work_outputs').get()).toEqual({ n: 2 })
})
