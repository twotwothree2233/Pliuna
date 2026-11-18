import { expect, it, vi } from 'vitest'
import type { ExecutionScope } from '../../src/shared/contracts.generated'
import { assertContract } from '../../src/shared/validation'
import { ChatAdapter } from '../../src/runtime/model/adapter'
import { compactContext, latestUser, recordedMessage } from '../../src/runtime/model/context'
import { captureExecutionScope, messageEvidence, requestEvidence, type RequestEvidence } from '../../src/runtime/model/request-evidence'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { lease as compactionLease, setup as compactionSetup } from '../helpers/compaction'

const production = (): ExecutionScope => ({ task_id: 'task', run_id: 'run', work_id: 'work', attempt_id: 'attempt', role: 'producer', purpose: 'production', request_id: 'goal-request', intent_revision: 2 })
const composition = (): ExecutionScope => ({ task_id: 'task', run_id: 'run', work_id: 'assembly', attempt_id: 'assembly-attempt', role: 'collator', purpose: 'composition', batch_id: 'batch', composition_version: 3, trigger_request_id: 'assembly-request' })
const configuration = { id: 'owned-model', base_url: 'https://example.invalid/v1', wire_model_id: 'synthetic', context_tokens: 1000000, max_output_tokens: 1024, compatibility_profile: 'chat-max-tokens' as const }

function setup(owner?: ExecutionScope) {
  const adapter = new ChatAdapter(), service = new ModelService(adapter), events: RequestEvidence[] = []
  service.configure({ type: 'model.configure', configuration, api_key: 'synthetic', confirm_memory_only: true })
  const complete = vi.spyOn(adapter, 'complete').mockResolvedValue({ text: 'done', calls: [], finish: 'stop' })
  const lease: ModelLease = { id: configuration.id, revision: 1, config: configuration, release() {}, owner, evidence: event => { events.push(event); return 'evidence-event' } }
  return { service, complete, lease, events }
}

it.each([production, composition])('binds model evidence to the exact execution while preserving standard provider messages', async createOwner => {
  const owner = createOwner(), expected = { ...owner }, s = setup(owner)
  const message = recordedMessage({ id: 'response-event', sequence: 1, kind: 'model.response', payload: { run_id: owner.run_id, owner, message: { role: 'assistant', content: 'Prior result' } } })!
  const messages = [message], before = JSON.stringify(messages)
  s.lease.accounting = event => { if (event.phase === 'reserved') owner.attempt_id = 'later-attempt' }
  const result = await s.service.request(s.lease, 'task', messages, undefined, new AbortController().signal)

  expect(s.events[0]?.owner).toEqual(expected)
  expect(s.events[0]?.entries[0]?.owner).toEqual(expected)
  expect(result.request_link).toEqual({ request_id: s.events[0]!.request_id, evidence_event_id: 'evidence-event' })
  assertContract('request_evidence', s.events[0])
  expect(s.complete.mock.calls[0]?.[2]).toBe(messages)
  expect(JSON.stringify(messages)).toBe(before)
  expect(Object.keys(message)).toEqual(['role', 'content'])
})

it('rejects a lease for another task before accounting or dispatch, even without an evidence hook', async () => {
  const s = setup({ ...production(), task_id: 'other-task' }), accounting = vi.fn()
  s.lease.accounting = accounting
  s.lease.evidence = undefined
  await expect(s.service.request(s.lease, 'task', [], undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RUNNER_OWNERSHIP_INVALID' })
  expect(accounting).not.toHaveBeenCalled()
  expect(s.complete).not.toHaveBeenCalled()
})

it('rejects source evidence from another task before the provider receives it', async () => {
  const s = setup(production())
  const message = recordedMessage({ id: 'foreign-event', sequence: 1, kind: 'model.response', payload: { owner: { ...production(), task_id: 'other-task' }, message: { role: 'assistant', content: 'Foreign result' } } })!
  await expect(s.service.request(s.lease, 'task', [message], undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'RUNNER_OWNERSHIP_INVALID' })
  expect(s.events).toEqual([])
  expect(s.complete).not.toHaveBeenCalled()
})

it('keeps recorded execution metadata separate from mutable source payloads and request manifests', () => {
  const owner = production(), expected = { ...owner }
  const message = recordedMessage({ id: 'owned-event', sequence: 7, kind: 'model.response', payload: { run_id: 'run', owner, message: { role: 'assistant', content: 'Recorded result' } } })!
  owner.attempt_id = 'changed-source'
  const manifest = requestEvidence([message], 'model-request', 'main', expected)
  messageEvidence(message)!.owner!.attempt_id = 'changed-metadata'
  expected.attempt_id = 'changed-caller'
  expect(manifest.owner?.attempt_id).toBe('attempt')
  expect(manifest.entries[0]?.owner.attempt_id).toBe('attempt')
})

it.each([
  { run_id: 'different-run', owner: production(), code: 'RUNNER_OWNERSHIP_INVALID' },
  { task_id: 'different-task', owner: production(), code: 'RUNNER_OWNERSHIP_INVALID' },
  { owner: { ...production(), attempt_id: undefined }, code: 'INVALID_RUNNER_CONTRACT' }
])('rejects malformed or conflicting recorded ownership', ({ code, ...payload }) => {
  expect(() => recordedMessage({ id: 'event', sequence: 1, kind: 'model.response', payload: { ...payload, message: { role: 'assistant', content: 'Result' } } })).toThrow(expect.objectContaining({ code }))
})

it('uses worker input as the latest host input with its event source and exact owner', () => {
  const owner = production()
  const input = recordedMessage({ id: 'worker-input', sequence: 5, kind: 'worker.input', payload: { run_id: owner.run_id, owner, text: 'Work goal', materials: [{ id: 'resource' }] } })!
  expect(JSON.parse(input.content!)).toEqual({ request: 'Work goal', request_materials: [{ id: 'resource' }] })
  expect(messageEvidence(input)).toMatchObject({ kind: 'host-state', source: { kind: 'event', id: 'worker-input' }, recorded_sequence: 5, owner })
  expect(latestUser([input])).toBe(input)
  expect(Object.keys(input)).toEqual(['role', 'content'])
})

it.each([production, composition])('preserves the summary execution owner across an asynchronous request', async createOwner => {
  const owner = createOwner(), expected = { ...owner }, s = compactionSetup()
  const lease = { ...compactionLease, owner }
  s.request.mockImplementation(async () => {
    owner.attempt_id = 'later-attempt'
    return { text: 'Owned working summary', calls: [], finish: 'stop' }
  })
  const next = await compactContext(s.service, lease, 'task', s.budget, s.controller.signal, s.messages, 6, undefined, s.host)
  const installed = s.install.mock.calls[0]![0]
  expect(s.request.mock.calls[0]![0].owner).toEqual(expected)
  expect(installed.owner).toEqual(expected)
  expect(messageEvidence(next[1]!)?.owner).toEqual(expected)
  expect(requestEvidence(next, 'next-request', 'main', expected).entries.find(entry => entry.kind === 'summary')?.owner).toEqual(expected)
  assertContract('installed_summary', installed)
  expect(JSON.stringify(next)).not.toContain('attempt_id')
})

it('rejects cross-task summary ownership before requesting or installing a summary', async () => {
  const s = compactionSetup(), lease = { ...compactionLease, owner: { ...production(), task_id: 'other-task' } }
  await expect(compactContext(s.service, lease, 'task', s.budget, s.controller.signal, s.messages, 6, undefined, s.host)).rejects.toMatchObject({ code: 'RUNNER_OWNERSHIP_INVALID' })
  expect(s.request).not.toHaveBeenCalled()
  expect(s.install).not.toHaveBeenCalled()
})

it('keeps legacy messages and summaries without inventing execution ownership', async () => {
  const s = compactionSetup(), next = await s.run()
  expect(captureExecutionScope(undefined)).toBeUndefined()
  expect(s.install.mock.calls[0]![0].owner).toBeUndefined()
  expect(messageEvidence(next[1]!)?.owner).toBeUndefined()
  expect(requestEvidence(next, 'legacy-request', 'main').owner).toBeUndefined()
})
