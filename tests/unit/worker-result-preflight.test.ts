import { afterEach, expect, it, vi } from 'vitest'
import type { ArtifactCandidate, Bundle } from '../../src/shared/contracts.generated'
import { ContractError } from '../../src/shared/validation'
import type { ChatMessage, Completion } from '../../src/runtime/model/adapter'
import { runAgent, type AgentHost, type WorkerExecution, type WorkerResultIssue } from '../../src/runtime/model/agent'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { createProducerProfile, validateProducerResult, type ProducerResult, type ProductionResultBinding } from '../../src/runtime/runner/production-profile'

afterEach(() => vi.restoreAllMocks())

const lease: ModelLease = {
  id: 'preflight', revision: 1,
  config: { id: 'preflight', base_url: 'https://example.invalid', wire_model_id: 'fixture', context_tokens: 1000000, compatibility_profile: 'chat-max-tokens' },
  release() {}
}
const source: ArtifactCandidate['provenance_ref'] = { task_id: 'task', kind: 'record', id: 'original-evidence' }
const missingSource: ArtifactCandidate['provenance_ref'] = { task_id: 'task', kind: 'record', id: 'goal' }
const issue: WorkerResultIssue = {
  code: 'RUNNER_PROVENANCE_INVALID', path: 'artifacts[0].provenance_ref', value: missingSource,
  message: 'The source record does not exist. Use an available source.', sources: [source]
}
const binding: ProductionResultBinding = {
  goal: { task_id: 'task', request_id: 'goal', intent_revision: 1, input_event_id: 'input', state: 'active', requirements: [{ requirement_id: 'document', kind: 'artifact', required: true, provenance_required: true }] },
  owner: { task_id: 'task', request_id: 'goal', intent_revision: 1, purpose: 'production', run_id: 'run', work_id: 'work', attempt_id: 'attempt', role: 'producer' },
  work: { task_id: 'task', request_id: 'goal', intent_revision: 1, purpose: 'production', run_id: 'run', work_id: 'work', role: 'producer', plan_revision: 1, state: 'running', current_attempt_id: 'attempt', requirement_ids: ['document'], required: true, max_attempts: 2, dependencies: [{ kind: 'goal', task_id: 'task', request_id: 'goal', intent_revision: 1 }] },
  sections: [{ section_id: 'section', request_id: 'goal', intent_revision: 1, position_revision: 1, order_key: 'first' }]
}

function result(candidate_id: string, provenance_ref = source): ProducerResult {
  return {
    version: 1, complete: true, answer: '内容已完成。', requirement_ids: ['document'], unresolved: [],
    artifacts: [{
      task_id: 'task', request_id: 'goal', intent_revision: 1, run_id: 'run', work_id: 'work', attempt_id: 'attempt', plan_revision: 1,
      dependencies: [{ kind: 'goal', task_id: 'task', request_id: 'goal', intent_revision: 1 }],
      artifact_id: 'artifact', candidate_id, base_artifact_revision: 0, bundle_resource_id: 'bundle-resource',
      section_id: 'section', section_position_revision: 1, order_key: 'first', presentation_kind: 'managed-v1',
      width_constraint: 'full', interaction_kind: 'none', provenance_ref, requirement_ids: ['document'], unresolved: []
    }]
  }
}
const final = (value: ProducerResult): Completion => ({ text: JSON.stringify(value), calls: [], finish: 'stop' })
function createBundle(): Completion {
  const bundle: Bundle = { profile: 'managed-v1', html: '<article>Content</article>', css: '', state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: '1' }, forms: [], behaviors: [], references: [], export: [] }
  return { text: '', finish: 'tool_calls', calls: [{ id: 'create-bundle', type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input: { display_name: 'Content', content: { type: 'json', value: bundle } } }) } }] }
}
function setup(responses: Completion[]) {
  const service = new ModelService(), messages: ChatMessage[][] = []
  const request = vi.spyOn(service, 'request').mockImplementation(async (_lease, _task, input) => {
    messages.push(structuredClone(input))
    const response = responses.shift()
    if (!response) throw new Error('Unexpected additional model request')
    return response
  })
  const records: { kind: string; payload: Record<string, unknown> }[] = []
  const tool = vi.fn<AgentHost['tool']>(async () => ({ execution: 'success', delivery: 'delivered', truncated: false, data: { id: 'bundle-resource' } }))
  const host: AgentHost = { valid() {}, state() {}, budget() {}, tool, record(kind, payload) { records.push({ kind, payload: structuredClone(payload) }) } }
  const onResult = vi.fn<WorkerExecution<ProducerResult>['onResult']>()
  const controller = new AbortController()
  // Exercise the generic preflight loop independently of production identity binding.
  const profile = { ...createProducerProfile(binding), parseResult: (response: Completion) => validateProducerResult(JSON.parse(response.text), binding) }
  const execute = (validateResult?: WorkerExecution<ProducerResult>['validateResult']) => runAgent(service, lease, 'task', [{ role: 'user', content: 'Create the document.' }], host, controller.signal, undefined, { profile, onResult, ...(validateResult ? { validateResult } : {}) })
  return { request, messages, records, tool, onResult, controller, execute }
}

it('corrects a rejected source in the same conversation without repeating a successful resource write', async () => {
  const rejected = result('first', missingSource), corrected = result('corrected')
  const run = setup([createBundle(), final(rejected), final(corrected)])
  const validateResult = vi.fn<NonNullable<WorkerExecution<ProducerResult>['validateResult']>>(value => value.artifacts[0]?.provenance_ref.id === missingSource.id ? issue : null)

  await run.execute(validateResult)

  expect(run.request).toHaveBeenCalledTimes(3)
  expect(run.tool).toHaveBeenCalledOnce()
  expect(run.tool.mock.calls[0]?.[0]).toMatchObject({ type: 'write', input: { type: 'resource.create', content: { type: 'json' } } })
  expect(validateResult).toHaveBeenCalledTimes(2)
  expect(run.onResult).toHaveBeenCalledExactlyOnceWith(corrected)
  const originalToolResult = run.messages[1]?.find(message => message.role === 'tool')
  expect(originalToolResult).toMatchObject({ tool_call_id: 'create-bundle' })
  expect(JSON.parse(originalToolResult?.content ?? '{}')).toMatchObject({ execution: 'success', data: { id: 'bundle-resource' } })
  expect(run.messages[2]).toContainEqual(originalToolResult)
  expect(run.messages[2]).toContainEqual({ role: 'assistant', content: JSON.stringify(rejected) })
  const feedback = run.messages[2]?.filter(message => message.role !== 'assistant' && message.role !== 'tool').map(message => message.content ?? '').join('\n') ?? ''
  for (const value of [issue.code, issue.path, issue.message, missingSource.id, source.id]) expect(feedback).toContain(value)
  expect(run.records.filter(record => record.kind === 'worker.result.rejected')).toEqual([{ kind: 'worker.result.rejected', payload: expect.objectContaining(issue) }])
  expect(run.records.filter(record => record.kind === 'message.assistant').map(record => record.payload.text)).toEqual([JSON.stringify(corrected)])
})

it('stops the same source error when only the candidate id and feedback wording change', async () => {
  const run = setup([final(result('first', missingSource)), final(result('different-candidate', missingSource)), final(result('corrected'))])
  const validateResult = vi.fn<NonNullable<WorkerExecution<ProducerResult>['validateResult']>>()
    .mockReturnValueOnce(issue)
    .mockReturnValueOnce({ ...issue, message: 'The same unavailable source remains invalid.', sources: [] })

  await expect(run.execute(validateResult)).rejects.toMatchObject({ code: issue.code })

  expect(run.request).toHaveBeenCalledTimes(2)
  expect(validateResult).toHaveBeenCalledTimes(2)
  expect(run.onResult).not.toHaveBeenCalled()
  expect(run.tool).not.toHaveBeenCalled()
})

it('propagates a fatal preflight error without asking the model to correct it', async () => {
  const run = setup([final(result('candidate')), final(result('unused'))])
  const fatal = new ContractError('TASK_STALE', 'The task is no longer active')
  const validateResult = vi.fn<NonNullable<WorkerExecution<ProducerResult>['validateResult']>>(() => { throw fatal })

  await expect(run.execute(validateResult)).rejects.toBe(fatal)

  expect(run.request).toHaveBeenCalledOnce()
  expect(validateResult).toHaveBeenCalledOnce()
  expect(run.onResult).not.toHaveBeenCalled()
  expect(run.records.filter(record => record.kind === 'worker.result.rejected')).toEqual([])
})

it.each(['response', 'preflight'])('does not continue when aborted during %s', async stage => {
  const run = setup([final(result('candidate')), final(result('unused'))])
  if (stage === 'response') run.request.mockImplementationOnce(async () => { run.controller.abort(); return final(result('candidate')) })
  const validateResult = vi.fn<NonNullable<WorkerExecution<ProducerResult>['validateResult']>>(() => { run.controller.abort(); return issue })

  await expect(run.execute(validateResult)).rejects.toMatchObject({ code: 'MODEL_CANCELLED' })

  expect(run.request).toHaveBeenCalledOnce()
  expect(validateResult).toHaveBeenCalledTimes(stage === 'preflight' ? 1 : 0)
  expect(run.onResult).not.toHaveBeenCalled()
  expect(run.records.filter(record => record.kind === 'worker.result.rejected')).toEqual([])
})

it('accepts a valid result once when no preflight is provided', async () => {
  const accepted = result('candidate'), run = setup([final(accepted)])

  await run.execute()

  expect(run.request).toHaveBeenCalledOnce()
  expect(run.onResult).toHaveBeenCalledExactlyOnceWith(accepted)
  expect(run.records.filter(record => record.kind === 'worker.result.rejected')).toEqual([])
})

it.each([false, true])('does not retry an acceptance failure when preflight is enabled: %s', async preflight => {
  const run = setup([final(result('candidate')), final(result('unused'))])
  const failure = new ContractError('RUNNER_PROVENANCE_INVALID', 'Acceptance observed a changed host state')
  run.onResult.mockImplementation(() => { throw failure })

  await expect(run.execute(preflight ? () => null : undefined)).rejects.toBe(failure)

  expect(run.request).toHaveBeenCalledOnce()
  expect(run.onResult).toHaveBeenCalledOnce()
  expect(run.records.filter(record => record.kind === 'worker.result.rejected')).toEqual([])
  expect(run.records.filter(record => record.kind === 'message.assistant')).toEqual([])
})
