import { describe, expect, it, vi } from 'vitest'
import { modelToolRequest } from '../../src/runtime/model/tool-input'
import { DISCOVER_INPUTS, dispatchOrchestrationTool, InitialWorkDraft, READ_BOUND_INPUT, REPORT_MISSING_INPUT, ROUTE_WORK } from '../../src/runtime/runner/orchestration-tool'
import { createConversationRouterProfile, createWorkRouterProfile } from '../../src/runtime/runner/chapter-router'
import { createWorkerProfile } from '../../src/runtime/runner/worker-profile'
import type { ContentPlan, ExecutionScope, ModelRequest, RouteWork } from '../../src/shared/contracts.generated'
import { checkAssignmentRequirements, installableAssignments } from '../../src/runtime/runner/orchestration-plan'
import { validateRunnerContract } from '../../src/shared/runner-validation'

type Owner = Extract<ExecutionScope, { purpose: 'production' }>
const owner: Owner = { task_id: 'task', run_id: 'run', request_id: 'request', intent_revision: 1, work_id: 'router', attempt_id: 'attempt', purpose: 'production', role: 'router' }
const worker: Owner = { ...owner, work_id: 'worker', role: 'producer' }
const answer = { output_key: 'answer', kind: 'answer' as const }
const assignment = { assignment_key: 'writer', instructions: 'Answer the user', required: true, requirement_ids: ['answer'], outputs: [answer] }
const dispatch = { action: 'dispatch', base_revision: 0, assignments: [assignment], final_answer: 'writer' } satisfies RouteWork
const binding = { work_id: 'source', plan_revision: 1, result_revision: 2, output_key: 'answer' }
const material = { kind: 'material', resource_id: 'notes' } as const
const published = { kind: 'published', view_id: 'view', view_revision: 2, node_id: 'section', revision: 1, tree_revision: 2 } as const

function call(capability: string, input: unknown): Extract<ModelRequest, { type: 'call' }> {
  const request = modelToolRequest('call', { capability, input_json: JSON.stringify(input) })
  if (request.type !== 'call') throw Error('Expected a capability call')
  return request
}

function fixture(revision = 0) {
  return { revision, route: vi.fn(() => ({ revision: revision + 1 })), report: vi.fn(() => ({ report_id: 'missing' })) }
}

describe('orchestration capability dispatch', () => {
  it('offers metadata discovery to both Router roles without requiring it for dispatch', () => {
    const host = { ...fixture(), catalog: vi.fn(() => ({ items: [], next_cursor: null })) }
    const discovery = call(DISCOVER_INPUTS, { kind: 'material' }), read = call(READ_BOUND_INPUT, { input_ref: 'attempt:0' })
    for (const profile of [createConversationRouterProfile([], []), createWorkRouterProfile(), createWorkRouterProfile('feedback')]) {
      expect(() => profile.authorize(discovery)).not.toThrow()
      expect(() => profile.authorize(call(ROUTE_WORK, dispatch))).not.toThrow()
    }
    expect(dispatchOrchestrationTool(discovery.input, owner, host)).toEqual({ items: [], next_cursor: null })
    expect(host.route).not.toHaveBeenCalled()
    const collator = createWorkerProfile({ id: 'collator', role: 'collator', system: 'Structure only', grants: [], parseResult: () => null })
    for (const request of [discovery, read, modelToolRequest('read', { kind: 'content_node', id: 'section' })]) expect(() => collator.authorize(request)).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
    expect(() => dispatchOrchestrationTool(discovery.input, { ...owner, role: 'collator' }, host)).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
  })

  it('does not accept user clarification from a feedback Router', () => {
    const result = { kind: 'clarification', question: 'Which format?' }
    const complete = (value: unknown) => ({ text: JSON.stringify(value), finish: 'stop' as const, calls: [] })
    const feedback = createWorkRouterProfile('feedback')
    expect(() => feedback.parseResult(complete(result))).toThrow(expect.objectContaining({
      code: 'INVALID_WORKER_RESULT', path: 'kind', message: expect.stringContaining('Feedback routing cannot deliver a user clarification')
    }))
    expect(feedback.parseResult(complete({ kind: 'blocked' }))).toEqual({ kind: 'blocked' })
    expect(createWorkRouterProfile().parseResult(complete(result))).toEqual(result)
  })

  it('preserves new content bindings alongside legacy output edges in a persisted assignment', () => {
    const draft = new InitialWorkDraft()
    draft.propose(call(ROUTE_WORK, { ...dispatch, assignments: [
      { ...assignment, assignment_key: 'extract', requirement_ids: [], required: false },
      { ...assignment, inputs: [material, published, { assignment_key: 'extract', output_key: 'answer' }, binding] }
    ] }).input)
    const ownerSource = { task_id: 'task', run_id: 'run', request_id: 'request', intent_revision: 1, dependencies: [] }
    const goal = { task_id: 'task', request_id: 'request', intent_revision: 1, input_event_id: 'input', state: 'active', requirements: [{ requirement_id: 'answer', kind: 'answer', required: true, provenance_required: false }] } satisfies ContentPlan
    const lookup = () => ({ ...ownerSource, purpose: 'production' as const, role: 'producer' as const, work_id: 'source', plan_revision: 1, state: 'succeeded' as const, result_revision: 2, required: false, requirement_ids: [], max_attempts: 1, assignment: { instructions: 'Extract', inputs: [], outputs: [answer] } })
    const ids = ['extract-id', 'writer-id'], checkContent = vi.fn()
    const [, writer] = installableAssignments(draft.decision()!, goal, ownerSource, () => ids.shift()!, lookup, [], undefined, checkContent)
    expect(validateRunnerContract('runner_logical_work', writer)).toMatchObject({ assignment: { inputs: [material, published, { work_id: 'extract-id', plan_revision: 1, output_key: 'answer' }, binding] } })
    expect(checkContent.mock.calls).toEqual([[material, 'writer'], [published, 'writer']])
  })

  it('rejects duplicate or malformed content references and preserves local cycle checks', () => {
    const draft = new InitialWorkDraft()
    for (const inputs of [[material, material], [published, { ...published, revision: 2 }], [{ ...material, task_id: 'other' }], [{ ...published, bundle_resource_id: 'file' }]]) {
      expect(() => draft.propose(call(ROUTE_WORK, { ...dispatch, assignments: [{ ...assignment, inputs }] }).input)).toThrow(expect.objectContaining({ code: 'INVALID_RUNNER_CONTRACT' }))
    }
    const cyclic = { ...dispatch, assignments: [{ ...assignment, inputs: [material, { assignment_key: 'writer', output_key: 'answer' }] }] }
    expect(() => draft.propose(call(ROUTE_WORK, cyclic).input)).toThrow(expect.objectContaining({ code: 'RUNNER_DEPENDENCY_CYCLE' }))
    expect(draft.decision()).toBeUndefined()
  })

  it('passes direct assignments, local edges and exact installed results to the host', () => {
    const initial = fixture()
    expect(dispatchOrchestrationTool(call(ROUTE_WORK, dispatch).input, owner, initial)).toEqual({ revision: 1 })
    const producer = { ...assignment, assignment_key: 'source', inputs: [binding] }
    const plan = { ...dispatch, assignments: [producer, { ...assignment, inputs: [{ assignment_key: 'source', output_key: 'answer' }] }] }
    dispatchOrchestrationTool(call(ROUTE_WORK, plan).input, owner, initial)
    expect(initial.route.mock.calls[1]).toEqual([plan, owner])
  })

  it('checks every artifact requirement claim against the output of that assignment', () => {
    const needs: ContentPlan['requirements'] = [{ requirement_id: 'report', kind: 'artifact', required: true, provenance_required: false }]
    const draft = { assignment_key: 'prepare', instructions: 'Prepare an internal draft', required: false, requirement_ids: ['report'], outputs: [{ output_key: 'draft', kind: 'artifact', exposure: 'handoff' }] } as const
    const publisher = { ...draft, assignment_key: 'publish', required: true, outputs: [{ output_key: 'final', kind: 'artifact', exposure: 'publish' }] as const }
    const plan = (outputs: typeof draft.outputs[number][] | typeof answer[], requirement_ids: string[]) => ({ action: 'dispatch', base_revision: 0, assignments: [
      { ...draft, outputs, requirement_ids }, { ...publisher, requirement_ids: ['report'], outputs: [...publisher.outputs], inputs: [{ assignment_key: 'prepare', output_key: outputs[0]!.output_key }] }
    ] }) satisfies Extract<RouteWork, { action: 'dispatch' }>
    for (const outputs of [[...draft.outputs], [answer]]) {
      expect(() => checkAssignmentRequirements(plan(outputs, ['report']), needs)).toThrow(expect.objectContaining({
        code: 'RUNNER_PLAN_CONFLICT', message: expect.stringContaining('Assignment "prepare" claims final artifact requirements ["report"]')
      }))
      expect(() => checkAssignmentRequirements(plan(outputs, []), needs)).not.toThrow()
    }
    const valid = plan([...draft.outputs], []), append = { ...valid, assignments: [valid.assignments[0]!] }
    const source = { task_id: 'task', run_id: 'run', request_id: 'request', intent_revision: 1, dependencies: [] }
    const goal = { ...source, input_event_id: 'input', state: 'active', requirements: needs } satisfies ContentPlan
    const ids = ['preparation', 'publication']
    const [internal, published] = installableAssignments(valid, goal, source, () => ids.shift()!, () => { throw Error('Expected only local inputs') })
    expect(() => checkAssignmentRequirements(append, needs, [{ ...internal!, required: true, requirement_ids: ['report'] }])).toThrow('The draft must preserve each required user outcome')
    expect(() => checkAssignmentRequirements(append, needs, [published!])).not.toThrow()
  })

  it('installs binding and local revision actions only against the current baseline', () => {
    const host = fixture(2)
    const bind = { action: 'bind', base_revision: 2, work_id: 'consumer', input: material } satisfies RouteWork
    const revise = { action: 'revise', base_revision: 2, changes: [{ work_id: 'consumer', instructions: 'Combine the verified results', inputs: [published, binding] }] } satisfies RouteWork
    for (const decision of [bind, revise]) {
      expect(dispatchOrchestrationTool(call(ROUTE_WORK, decision).input, owner, host)).toEqual({ revision: 3 })
      expect(() => dispatchOrchestrationTool(call(ROUTE_WORK, { ...decision, base_revision: 1 }).input, owner, host)).toThrow(expect.objectContaining({ code: 'RUNNER_PLAN_CONFLICT' }))
    }
    expect(host.route).toHaveBeenCalledTimes(2)
  })

  it('rejects ambiguous local references and fields that override user authority', () => {
    const host = fixture()
    const invalid = [
      { ...dispatch, request_id: 'other' },
      { ...dispatch, final_answer: 'unknown' },
      { ...dispatch, assignments: [assignment, assignment] },
      { ...dispatch, assignments: [{ ...assignment, inputs: [{ assignment_key: 'unknown', output_key: 'answer' }] }] },
      { action: 'revise', base_revision: 0, changes: [{ work_id: 'consumer', required: false }] }
    ]
    for (const decision of invalid) expect(() => dispatchOrchestrationTool(call(ROUTE_WORK, decision).input, owner, host)).toThrow(expect.objectContaining({ code: 'INVALID_RUNNER_CONTRACT' }))
    expect(host.route).not.toHaveBeenCalled()
  })

  it('identifies exactly which output has invalid exposure', () => {
    const host = fixture()
    const text = { ...dispatch, assignments: [{ ...assignment, outputs: [{ ...answer, exposure: 'handoff' }] }] }
    const artifact = { ...dispatch, assignments: [{ ...assignment, outputs: [answer, { output_key: 'card', kind: 'artifact' }] }] }
    expect(() => dispatchOrchestrationTool(call(ROUTE_WORK, text).input, owner, host)).toThrow('Remove exposure from text output writer.answer')
    expect(() => dispatchOrchestrationTool(call(ROUTE_WORK, artifact).input, owner, host)).toThrow('Artifact output writer.card requires exposure')
    expect(host.route).not.toHaveBeenCalled()
  })

  it('accepts a bounded Worker report but never grants it dispatch authority', () => {
    const host = fixture()
    const report = { missing: 'Source table', impact: 'Cannot confirm totals', wait: true, references: [{ task_id: 'task', kind: 'record', id: 'evidence' }] }
    const request = call(REPORT_MISSING_INPUT, report)
    const input = { id: 'profile', system: 'Bound work', parseResult: () => null }
    const profile = createWorkerProfile({ ...input, role: 'producer', grants: [{ type: 'call', capability: REPORT_MISSING_INPUT }] })
    expect(() => profile.authorize(request)).not.toThrow()
    expect(() => profile.authorize(call(ROUTE_WORK, dispatch))).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
    for (const role of ['producer', 'collator', 'diagnostic'] as const) {
      expect(() => createWorkerProfile({ ...input, role, grants: [{ type: 'call', capability: ROUTE_WORK }] })).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_PROFILE' }))
      expect(() => dispatchOrchestrationTool(call(ROUTE_WORK, dispatch).input, { ...owner, role }, host)).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
    }
    expect(() => dispatchOrchestrationTool(request.input, owner, host)).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
    expect(() => dispatchOrchestrationTool(request.input, worker)).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
    expect(() => dispatchOrchestrationTool(call(REPORT_MISSING_INPUT, { ...report, references: [{ ...report.references[0], task_id: 'other' }] }).input, worker, host)).toThrow(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
    expect(dispatchOrchestrationTool(request.input, worker, host)).toEqual({ report_id: 'missing' })
    expect(host.report).toHaveBeenCalledExactlyOnceWith(report, worker)
  })
})
