import { describe, expect, it, vi } from 'vitest'
import { modelToolRequest } from '../../src/runtime/model/tool-input'
import { dispatchOrchestrationTool, REPORT_MISSING_INPUT, ROUTE_WORK } from '../../src/runtime/runner/orchestration-tool'
import { createWorkerProfile } from '../../src/runtime/runner/worker-profile'
import type { ExecutionScope, ModelRequest, RouteWork } from '../../src/shared/contracts.generated'

type Owner = Extract<ExecutionScope, { purpose: 'production' }>
const owner: Owner = { task_id: 'task', run_id: 'run', request_id: 'request', intent_revision: 1, work_id: 'router', attempt_id: 'attempt', purpose: 'production', role: 'router' }
const worker: Owner = { ...owner, work_id: 'worker', role: 'producer' }
const answer = { output_key: 'answer', kind: 'answer' as const }
const assignment = { assignment_key: 'writer', instructions: 'Answer the user', required: true, requirement_ids: ['answer'], outputs: [answer] }
const dispatch = { action: 'dispatch', base_revision: 0, assignments: [assignment], final_answer: 'writer' } satisfies RouteWork
const binding = { work_id: 'source', plan_revision: 1, result_revision: 2, output_key: 'answer' }

function call(capability: string, input: unknown): Extract<ModelRequest, { type: 'call' }> {
  const request = modelToolRequest('call', { capability, input_json: JSON.stringify(input) })
  if (request.type !== 'call') throw Error('Expected a capability call')
  return request
}

function fixture(revision = 0) {
  return { revision, route: vi.fn(() => ({ revision: revision + 1 })), report: vi.fn(() => ({ report_id: 'missing' })) }
}

describe('orchestration capability dispatch', () => {
  it('passes direct assignments, local edges and exact installed results to the host', () => {
    const initial = fixture()
    expect(dispatchOrchestrationTool(call(ROUTE_WORK, dispatch).input, owner, initial)).toEqual({ revision: 1 })
    const producer = { ...assignment, assignment_key: 'source', inputs: [binding] }
    const plan = { ...dispatch, assignments: [producer, { ...assignment, inputs: [{ assignment_key: 'source', output_key: 'answer' }] }] }
    dispatchOrchestrationTool(call(ROUTE_WORK, plan).input, owner, initial)
    expect(initial.route.mock.calls[1]).toEqual([plan, owner])
  })

  it('installs binding and local revision actions only against the current baseline', () => {
    const host = fixture(2)
    const bind = { action: 'bind', base_revision: 2, work_id: 'consumer', input: binding } satisfies RouteWork
    const revise = { action: 'revise', base_revision: 2, changes: [{ work_id: 'consumer', instructions: 'Combine the verified results', inputs: [binding] }] } satisfies RouteWork
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
