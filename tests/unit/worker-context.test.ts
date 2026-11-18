import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import type { ExecutionAttempt, ExecutionScope, LogicalWork, WorkDependency } from '../../src/shared/contracts.generated'
import type { ChatMessage, ToolCall } from '../../src/runtime/model/adapter'
import { latestUser, retainedContext, type InstalledSummary } from '../../src/runtime/model/context'
import { messageEvidence, requestEvidence } from '../../src/runtime/model/request-evidence'
import { WorkerContext } from '../../src/runtime/runner/worker-context'
import { assertContract } from '../../src/shared/validation'

const coreSql = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runnerSql = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const system: ChatMessage = { role: 'system', content: 'Worker rules' }
const owner: ExecutionScope = { task_id: 'task', run_id: 'run', work_id: 'work', attempt_id: 'attempt', role: 'producer', purpose: 'production', request_id: 'goal', intent_revision: 1 }
const composition: ExecutionScope = { task_id: 'task', run_id: 'run', work_id: 'work', attempt_id: 'attempt', role: 'collator', purpose: 'composition', batch_id: 'batch', composition_version: 1, trigger_request_id: 'goal' }
const call = (id = 'same-id', resource = 'resource'): ToolCall => ({ id, type: 'function', function: { name: 'read', arguments: JSON.stringify({ kind: 'resource', id: resource }) } })
const response = (text: string, calls?: ToolCall[]): { message: ChatMessage } => ({ message: { role: 'assistant', content: text, ...(calls ? { tool_calls: calls } : {}) } })
const result = (text: string, id = 'same-id'): { message: ChatMessage } => ({ message: { role: 'tool', tool_call_id: id, content: text } })
function setup(selected: ExecutionScope = owner) {
  const db = new Database(':memory:'); databases.push(db)
  db.exec(coreSql); db.exec(runnerSql)
  db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1),('other-task','Other','active',1)").run()
  let count = 0
  const record = (kind: string, payload: Record<string, unknown>, scope: ExecutionScope | null = selected): string => {
    const task = scope?.task_id ?? selected.task_id
    const sequence = (db.prepare('SELECT next_sequence FROM tasks WHERE id=?').get(task) as { next_sequence: number }).next_sequence, id = `record-${++count}`
    db.prepare('INSERT INTO records(id,task_id,sequence,kind,payload_json,created_at) VALUES (?,?,?,?,?,?)').run(id, task, sequence, kind, JSON.stringify({ ...(scope ? { owner: scope, run_id: scope.run_id } : {}), ...payload }), 'time')
    db.prepare('UPDATE tasks SET next_sequence=next_sequence+1 WHERE id=?').run(task)
    return id
  }
  const context = new WorkerContext(db, selected)
  return { db, record, context, selected }
}
function summary(fixture: ReturnType<typeof setup>, latest_user_id: string | null = null, retained_interactions: string[][] = []): InstalledSummary {
  return { version: 2, text: 'Summary of this attempt', through_sequence: fixture.context.sequence(), latest_user_id, retained_interactions, template: 'summary-v0.1', model_id: 'model', model_revision: 1, installed_at: 'time', owner: { ...fixture.selected } }
}
function grants(fixture: ReturnType<typeof setup>, dependencies: WorkDependency[]): void {
  const { db, selected } = fixture
  if (selected.purpose !== 'production') throw Error('Production fixture required')
  db.prepare("INSERT INTO requests(id,task_id,state,config_selection_json,input_json,created_at) VALUES (?,?,'started','{}','{}','time')").run(selected.request_id, selected.task_id)
  db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,?,?,'running','epoch','{}','{}','time')").run(selected.run_id, selected.task_id, selected.request_id)
  db.prepare("INSERT INTO runner_budgets(budget_id,task_id,purpose,request_id,limits_json,created_at) VALUES ('budget',?,'production',?,'{}','time')").run(selected.task_id, selected.request_id)
  const run = { task_id: selected.task_id, run_id: selected.run_id, purpose: 'production', request_id: selected.request_id, intent_revision: selected.intent_revision, runtime_epoch: 'epoch', state: 'running', commit_valid: true, budget_id: 'budget' }
  db.prepare("INSERT INTO runner_runs(run_id,task_id,purpose,request_id,intent_revision,budget_id,payload_json) VALUES (?,?,'production',?,?,'budget',?)").run(selected.run_id, selected.task_id, selected.request_id, selected.intent_revision, JSON.stringify(run))
  const work: LogicalWork = { task_id: selected.task_id, run_id: selected.run_id, work_id: selected.work_id, role: selected.role, purpose: 'production', request_id: selected.request_id, intent_revision: selected.intent_revision, plan_revision: 1, required: true, requirement_ids: ['answer'], dependencies, state: 'queued', max_attempts: 2, current_attempt_id: selected.attempt_id }
  const attempt: ExecutionAttempt = { task_id: selected.task_id, run_id: selected.run_id, work_id: selected.work_id, attempt_id: selected.attempt_id, purpose: 'production', request_id: selected.request_id, intent_revision: selected.intent_revision, runtime_epoch: 'epoch', attempt_number: 1, profile_id: 'profile', model_config_id: 'model', model_config_revision: 1, input_versions: dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [] }
  db.prepare('INSERT INTO runner_work(work_id,task_id,run_id,plan_revision,state,payload_json) VALUES (?,?,?,1,?,?)').run(work.work_id, work.task_id, work.run_id, work.state, JSON.stringify(work))
  db.prepare('INSERT INTO runner_attempts(attempt_id,task_id,work_id,run_id,attempt_number,state,payload_json) VALUES (?,?,?,?,1,?,?)').run(attempt.attempt_id, attempt.task_id, attempt.work_id, attempt.run_id, attempt.state, JSON.stringify(attempt))
}

it('filters interleaved work before restoring complete batches with the same call IDs', () => {
  const fixture = setup(), sibling: ExecutionScope = { ...owner, work_id: 'sibling', attempt_id: 'sibling-attempt' }
  fixture.record('worker.input', { text: 'Current request', materials: [{ resource_id: 'allowed-material' }] })
  fixture.record('worker.input', { text: 'PRIVATE SIBLING INPUT' }, sibling)
  fixture.record('model.response', response('', [call('same-id'), call('second-id')]))
  fixture.record('model.response', response('PRIVATE SIBLING RESPONSE', [call('same-id')]), sibling)
  fixture.record('model.tool_result', result('PRIVATE SIBLING RESULT'), sibling)
  fixture.record('model.tool_result', result('Current result'))
  fixture.record('model.tool_result', result('Second result', 'second-id'))
  fixture.record('model.response', response('Current answer'))
  const messages = fixture.context.load(system)
  expect(messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'assistant'])
  expect(messages[1]?.content).toBe(JSON.stringify({ request: 'Current request', request_materials: [{ resource_id: 'allowed-material' }] }))
  expect(JSON.stringify(messages)).not.toContain('PRIVATE')
  expect(messages.slice(1).every(message => JSON.stringify(messageEvidence(message)?.owner) === JSON.stringify(owner))).toBe(true)
  expect(messageEvidence(messages[3]!)?.read_target).toEqual({ kind: 'resource', id: 'resource' })
})

const otherScopes: [string, ExecutionScope][] = [
  ['Task', { ...owner, task_id: 'other-task' }], ['Run', { ...owner, run_id: 'other-run' }], ['work', { ...owner, work_id: 'other-work' }],
  ['attempt', { ...owner, attempt_id: 'other-attempt' }], ['goal', { ...owner, request_id: 'other-goal' }], ['revision', { ...owner, intent_revision: 2 }], ['role', { ...owner, role: 'router' }], ['purpose', composition]
]
it.each(otherScopes)('excludes records from another %s even when other identity fields match', (_field, other) => {
  const fixture = setup()
  fixture.record('worker.input', { text: 'Current request' })
  fixture.record('model.response', response('PRIVATE OTHER SOURCE'), other)
  expect(fixture.context.load(system).map(message => message.content)).not.toContain('PRIVATE OTHER SOURCE')
  expect(fixture.context.sequence()).toBe(1)
  expect(fixture.context.hasFresh(1)).toBe(false)
})

it.each(['batch_id', 'composition_version', 'trigger_request_id'] as const)('keeps composition %s in its exact context identity', field => {
  const fixture = setup(composition), other = { ...composition, [field]: field === 'composition_version' ? 2 : 'other' }
  fixture.record('worker.input', { text: 'Current structure' })
  fixture.record('model.response', response('PRIVATE OTHER BATCH'), other)
  expect(fixture.context.load(system)).toHaveLength(2)
})

it('captures the owner and ignores unowned Task history and duplicate assistant projections', () => {
  const selected: ExecutionScope = { ...owner }, fixture = setup(selected)
  fixture.record('worker.input', { text: 'Current request' })
  selected.attempt_id = 'changed-after-construction'
  fixture.record('model.response', response('PRIVATE MUTATED OWNER'), selected)
  fixture.record('message.user', { text: 'PRIVATE TASK INPUT' }, null)
  fixture.record('message.assistant', { text: 'PRIVATE PROJECTION' }, owner)
  fixture.db.prepare("INSERT INTO records VALUES ('invalid-legacy','task',100,'model.response','invalid JSON','time')").run()
  expect(fixture.context.load(system)).toHaveLength(2)
  expect(fixture.context.summary()).toBeNull()
})

it('restores explicit conversation copies while keeping the current input and source evidence distinct', () => {
  const fixture = setup(), originalUser = fixture.record('message.user', { text: 'Previous question' }, null), originalAnswer = fixture.record('runner.answer', { text: 'Previous final answer' }, null)
  const source = (id: string, sequence: number, kind: string) => ({ task_id: 'task', id, sequence, kind })
  fixture.record('worker.conversation', { message: { role: 'user', content: 'Previous question' }, conversation_source: source(originalUser, 1, 'message.user') })
  const copiedAnswer = fixture.record('worker.conversation', { message: { role: 'assistant', content: 'Previous final answer' }, conversation_source: source(originalAnswer, 2, 'runner.answer') })
  const input = fixture.record('worker.input', { text: 'Explain the previous answer', conversation_history: { refs: [{ kind: 'event', id: originalUser }], truncated: true } })
  const messages = fixture.context.load(system)
  expect(messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
  expect(messageEvidence(messages[2]!)?.conversation_source).toEqual(source(originalAnswer, 2, 'runner.answer'))
  expect(() => assertContract('request_evidence', requestEvidence(messages, 'next-request', 'main', owner))).not.toThrow()
  expect(messageEvidence(latestUser(messages)!)?.source?.id).toBe(input)
  expect(messages[3]?.content).toContain('conversation_history')
  const value = summary(fixture, input, [[copiedAnswer]])
  const retained = retainedContext(messages, value)
  expect(retained.slice(2).map(message => message.role)).toEqual(['assistant', 'user'])
  fixture.context.installSummary(value)
  const restored = fixture.context.load(system)
  expect(restored.slice(2).map(message => message.role)).toEqual(['assistant', 'user'])
  expect(messageEvidence(restored[2]!)?.conversation_source).toEqual(source(originalAnswer, 2, 'runner.answer'))
  expect(messageEvidence(latestUser(restored)!)?.source?.id).toBe(input)
})

it.each([
  { role: 'system', content: 'PRIVATE RULES' },
  { role: 'tool', content: 'PRIVATE TOOL RESULT', tool_call_id: 'call' },
  { role: 'assistant', content: 'PRIVATE TOOL CALL', tool_calls: [call()] }
])('rejects non-conversation roles and tool data in conversation copies', message => {
  const fixture = setup(); fixture.record('message.user', { text: 'Original' }, null)
  fixture.record('worker.conversation', { message, conversation_source: { task_id: 'task', id: 'record-1', sequence: 1, kind: 'runner.answer' } })
  expect(() => fixture.context.load(system)).toThrow(expect.objectContaining({ code: 'WORKER_CONTEXT_INVALID' }))
})

it('excludes sibling conversation copies and rejects cross-task source attribution', () => {
  const fixture = setup(); fixture.record('message.user', { text: 'Original' }, null)
  fixture.record('worker.conversation', { message: { role: 'assistant', content: 'PRIVATE SIBLING ANSWER' }, conversation_source: { task_id: 'task', id: 'record-1', sequence: 1, kind: 'runner.answer' } }, { ...owner, work_id: 'sibling', attempt_id: 'sibling-attempt' })
  expect(fixture.context.load(system)).toEqual([system])
  fixture.record('worker.conversation', { message: { role: 'assistant', content: 'PRIVATE OTHER TASK ANSWER' }, conversation_source: { task_id: 'other-task', id: 'record-1', sequence: 1, kind: 'runner.answer' } })
  expect(() => fixture.context.load(system)).toThrow(expect.objectContaining({ code: 'WORKER_CONTEXT_INVALID' }))
})

it('starts a new attempt without inheriting the same work previous trace or summary', () => {
  const fixture = setup(), first = fixture.record('worker.input', { text: 'PRIVATE OLD INPUT' })
  const answer = fixture.record('model.response', response('PRIVATE OLD ANSWER'))
  fixture.context.installSummary(summary(fixture, first, [[answer]]))
  const nextOwner: ExecutionScope = { ...owner, attempt_id: 'next-attempt' }, next = new WorkerContext(fixture.db, nextOwner)
  expect(next.load(system)).toEqual([system]); expect(next.summary()).toBeNull()
  fixture.record('worker.input', { text: 'Fresh input' }, nextOwner)
  expect(JSON.stringify(next.load(system))).not.toContain('PRIVATE OLD')
  expect(() => next.installSummary({ ...summary(fixture, first, [[answer]]), owner: nextOwner, through_sequence: next.sequence() })).toThrow(expect.objectContaining({ code: 'SUMMARY_STORED_INVALID' }))
})

it('preserves every interrupted tool batch byte as owned history instead of replaying orphan tools', () => {
  const fixture = setup(), body = '中😀'.repeat(10000)
  fixture.record('worker.input', { text: 'Current request' })
  fixture.record('model.response', response('Interrupted response', [call('a'), call('b')]))
  fixture.record('model.tool_result', result(body, 'a'))
  fixture.record('worker.input', { text: 'Continue safely' })
  fixture.record('model.tool_result', result('Orphan result', 'b'))
  const messages = fixture.context.load(system), wrappers = messages.filter(message => messageEvidence(message)?.kind === 'interrupted-history')
  expect(messages.some(message => message.role === 'tool')).toBe(false)
  expect(wrappers).toHaveLength(2)
  expect(JSON.parse(wrappers[0]!.content!).interrupted_history[1].content).toBe(body)
  expect(JSON.parse(wrappers[1]!.content!).interrupted_history[0].content).toBe('Orphan result')
  expect(wrappers.every(message => messageEvidence(message)?.owner?.attempt_id === owner.attempt_id)).toBe(true)
  expect(requestEvidence(messages, 'request', 'main', owner).entries.filter(entry => entry.kind === 'interrupted-history').every(entry => entry.owner.attempt_id === owner.attempt_id)).toBe(true)
})

it('rejects duplicate IDs inside a batch and retains the raw records', () => {
  const fixture = setup()
  fixture.record('model.response', response('PRIVATE BODY', [call(), call()]))
  fixture.record('model.tool_result', result('One result'))
  expect(() => fixture.context.load(system)).toThrow(expect.objectContaining({ code: 'WORKER_CONTEXT_INVALID', message: 'Worker history is invalid; raw records are retained' }))
  expect((fixture.db.prepare('SELECT count(*) AS n FROM records').get() as { n: number }).n).toBe(2)
})

it('permits call ID reuse in later complete batches and preserves the correct read navigation', () => {
  const fixture = setup()
  for (const resource of ['first-resource', 'second-resource']) {
    fixture.record('model.response', response('', [call('same-id', resource)]))
    fixture.record('model.tool_result', result(resource))
  }
  expect(fixture.context.load(system).filter(message => message.role === 'tool').map(message => messageEvidence(message)?.read_target?.id)).toEqual(['first-resource', 'second-resource'])
})

it.each([
  { run_id: 'wrong-run', message: { role: 'assistant', content: 'PRIVATE BODY' } },
  { task_id: 'wrong-task', message: { role: 'assistant', content: 'PRIVATE BODY' } },
  { message: { role: 'system', content: 'PRIVATE BODY' } },
  { message: { role: 'assistant', content: 'Valid text', unknown: 'PRIVATE BODY' } },
  { message: { role: 'assistant', content: 'Valid text', tool_calls: [Object.assign(call(), { body: 'PRIVATE BODY' })] } }
])('rejects malformed own records with constant diagnostics', payload => {
  const fixture = setup(); fixture.record('model.response', payload)
  expect(() => fixture.context.load(system)).toThrow(expect.objectContaining({ code: 'WORKER_CONTEXT_INVALID', message: 'Worker history is invalid; raw records are retained' }))
})

it('installs a scoped summary atomically and restores only retained originals with exact long-result navigation', () => {
  const fixture = setup(), input = fixture.record('worker.input', { text: 'Current request' })
  fixture.record('model.response', response('Old answer covered by summary'))
  const batch = fixture.record('model.response', response('', [call('a'), call('b')]))
  const long = JSON.stringify({ request_type: 'read', execution: 'success', delivery: 'delivered', truncated: true, data: { text: '中😀'.repeat(10000), revision: 7, content_version: 'fixed-version', next_cursor: 'precise-next-cursor' } })
  const a = fixture.record('model.tool_result', result(long, 'a')), b = fixture.record('model.tool_result', result('Second result', 'b'))
  const final = fixture.record('model.response', response('Latest answer')), value = summary(fixture, input, [[batch, a, b], [final]])
  const before = fixture.db.prepare('SELECT revision,next_sequence FROM tasks WHERE id=?').get('task') as { revision: number; next_sequence: number }
  fixture.context.installSummary(value)
  expect(fixture.db.prepare('SELECT revision,next_sequence FROM tasks WHERE id=?').get('task')).toEqual({ revision: before.revision + 1, next_sequence: before.next_sequence + 1 })
  expect(fixture.context.summary()).toMatchObject(value)
  expect(fixture.context.hasFresh(value.through_sequence)).toBe(false)
  const messages = fixture.context.load(system)
  expect(messages.map(message => message.role)).toEqual(['system', 'user', 'user', 'assistant', 'tool', 'tool', 'assistant'])
  expect(messages[1]?.content).toContain(value.text)
  expect(messages[4]?.content).toBe(long)
  expect(JSON.parse(messages[4]!.content!).data.next_cursor).toBe('precise-next-cursor')
  expect(JSON.stringify(messages)).not.toContain('Old answer covered')
  expect(messageEvidence(messages[1]!)?.owner).toEqual(owner)
})

it.each(['missing-owner', 'other-attempt', 'other-work', 'other-task', 'wrong-run'] as const)('rejects a summary with %s before appending it', reason => {
  const fixture = setup(), input = fixture.record('worker.input', { text: 'Current request' }), value = summary(fixture, input)
  if (reason === 'missing-owner') delete value.owner
  else if (reason === 'wrong-run') Object.assign(value, { run_id: 'PRIVATE WRONG RUN' })
  else value.owner = { ...owner, [reason === 'other-attempt' ? 'attempt_id' : reason === 'other-work' ? 'work_id' : 'task_id']: 'PRIVATE OTHER SOURCE' }
  expect(() => fixture.context.installSummary(value)).toThrow(expect.objectContaining({ code: 'SUMMARY_STORED_INVALID', message: 'Worker summary or retained originals are invalid; raw records are retained' }))
  expect(fixture.context.summary()).toBeNull()
})

it.each(['other-work', 'other-attempt', 'other-task', 'message-user', 'assistant-as-input'] as const)('rejects summary references to %s without expanding history access', reason => {
  const fixture = setup(), input = fixture.record('worker.input', { text: 'Current request' })
  const other = reason === 'other-work' ? { ...owner, work_id: 'other-work' } : reason === 'other-attempt' ? { ...owner, attempt_id: 'other-attempt' } : reason === 'other-task' ? { ...owner, task_id: 'other-task' } : owner
  const referenced = fixture.record(reason === 'message-user' ? 'message.user' : 'model.response', reason === 'message-user' ? { text: 'PRIVATE BODY' } : response('PRIVATE BODY'), other)
  const value = summary(fixture, reason === 'assistant-as-input' ? referenced : input, reason === 'assistant-as-input' ? [] : [[referenced]])
  expect(() => fixture.context.installSummary(value)).toThrow(expect.objectContaining({ code: 'SUMMARY_STORED_INVALID' }))
})

it.each(['missing-result', 'reversed-results', 'duplicate-reference', 'reversed-groups', 'multiple-responses', 'user-in-interaction'] as const)('rejects a summary with %s', reason => {
  const fixture = setup(), input = fixture.record('worker.input', { text: 'Current request' })
  const first = fixture.record('model.response', response('', [call('a'), call('b')])), a = fixture.record('model.tool_result', result('a', 'a')), b = fixture.record('model.tool_result', result('b', 'b')), final = fixture.record('model.response', response('Final'))
  const groups = reason === 'missing-result' ? [[first, a]] : reason === 'reversed-results' ? [[first, b, a]] : reason === 'duplicate-reference' ? [[first, a, b], [first, a, b]] : reason === 'reversed-groups' ? [[final], [first, a, b]] : reason === 'multiple-responses' ? [[first, a, b, final]] : [[input]]
  expect(() => fixture.context.installSummary(summary(fixture, input, groups))).toThrow(expect.objectContaining({ code: 'SUMMARY_STORED_INVALID' }))
})

it('rejects a future summary watermark and own-history races while ignoring unrelated arrivals', () => {
  const fixture = setup(), input = fixture.record('worker.input', { text: 'Current request' }), value = summary(fixture, input)
  expect(() => fixture.context.installSummary({ ...value, through_sequence: value.through_sequence + 1 })).toThrow(expect.objectContaining({ code: 'SUMMARY_STORED_INVALID' }))
  fixture.record('model.response', response('Sibling update'), { ...owner, work_id: 'sibling', attempt_id: 'sibling-attempt' })
  expect(fixture.context.hasFresh(value.through_sequence)).toBe(false)
  fixture.context.installSummary(value)
  const installed = fixture.context.summary()
  fixture.record('model.response', response('Current update'))
  expect(fixture.context.hasFresh(value.through_sequence)).toBe(true)
  expect(() => fixture.context.installSummary(value)).toThrow(expect.objectContaining({ code: 'SUMMARY_SNAPSHOT_CHANGED' }))
  expect(fixture.context.summary()).toEqual(installed)
})

it('revalidates stored summary sources on every read and does not fall back to an older valid summary', () => {
  const fixture = setup(), input = fixture.record('worker.input', { text: 'Current request' }), final = fixture.record('model.response', response('Final'))
  fixture.context.installSummary(summary(fixture, input, [[final]]))
  const original = JSON.parse((fixture.db.prepare('SELECT payload_json FROM records WHERE id=?').get(final) as { payload_json: string }).payload_json)
  fixture.db.prepare('UPDATE records SET payload_json=? WHERE id=?').run(JSON.stringify({ ...original, owner: { ...owner, attempt_id: 'other-attempt' } }), final)
  expect(() => fixture.context.summary()).toThrow(expect.objectContaining({ code: 'SUMMARY_STORED_INVALID' }))
  fixture.db.prepare('UPDATE records SET payload_json=? WHERE id=?').run(JSON.stringify(original), final)
  fixture.record('context.summary.installed', { ...summary(fixture, input, [['missing-original']]), text: 'PRIVATE INVALID SUMMARY' })
  expect(() => fixture.context.load(system)).toThrow(expect.objectContaining({ code: 'SUMMARY_STORED_INVALID' }))
})

function exactPayload(bytes: number, marker: string): Record<string, unknown> {
  const payload = { owner, run_id: owner.run_id, ...response('') }
  const remaining = bytes - Buffer.byteLength(JSON.stringify(payload))
  return { ...payload, ...response(marker.repeat(Math.floor(remaining / Buffer.byteLength(marker))) + 'a'.repeat(remaining % Buffer.byteLength(marker))) }
}

it('enforces the single-record UTF-8 byte boundary without truncating or deleting originals', () => {
  const fixture = setup(), accepted = exactPayload(1024 * 1024, '中😀')
  fixture.record('model.response', accepted)
  expect(Buffer.byteLength(JSON.stringify(accepted))).toBe(1024 * 1024)
  expect(fixture.context.load(system)[1]?.content).toBe((accepted.message as ChatMessage).content)
  const rejected = exactPayload(1024 * 1024 + 1, '中😀')
  fixture.record('model.response', rejected)
  expect(() => fixture.context.load(system)).toThrow(expect.objectContaining({ code: 'CONTEXT_RECORD_LIMIT' }))
  expect((fixture.db.prepare('SELECT count(*) AS n FROM records').get() as { n: number }).n).toBe(2)
})

it('enforces the complete context byte limit across individually valid records', () => {
  const fixture = setup(), payload = exactPayload(1024 * 1024, 'a')
  fixture.db.transaction(() => { for (let index = 0; index < 8; index++) fixture.record('model.response', payload) })()
  expect(fixture.context.load(system)).toHaveLength(9)
  fixture.record('model.response', response('One more record'))
  expect(() => fixture.context.load(system)).toThrow(expect.objectContaining({ code: 'CONTEXT_RECORD_LIMIT' }))
})

it('bounds retained originals during summary validation before loading their full set', () => {
  const fixture = setup(), groups: string[][] = []
  fixture.db.transaction(() => {
    for (const batch of ['first', 'second']) {
      const calls = ['a', 'b', 'c', 'd'].map(id => call(`${batch}-${id}`)), responseId = fixture.record('model.response', response('', calls))
      const results = calls.map(tool => {
        const payload = { owner, run_id: owner.run_id, ...result('', tool.id) }
        const text = 'a'.repeat(1024 * 1024 - Buffer.byteLength(JSON.stringify(payload)))
        return fixture.record('model.tool_result', { ...payload, ...result(text, tool.id) })
      })
      groups.push([responseId, ...results])
    }
  })()
  expect(() => fixture.context.installSummary(summary(fixture, null, groups))).toThrow(expect.objectContaining({ code: 'CONTEXT_RECORD_LIMIT' }))
  expect(fixture.context.summary()).toBeNull()
  expect((fixture.db.prepare('SELECT count(*) AS n FROM records').get() as { n: number }).n).toBe(10)
})

it('enforces the original-record count without silently shortening history', () => {
  const fixture = setup()
  fixture.db.transaction(() => { for (let index = 0; index < 4096; index++) fixture.record('worker.input', { text: 'Input' }) })()
  expect(fixture.context.load(system)).toHaveLength(4097)
  fixture.record('worker.input', { text: 'Last input' })
  expect(() => fixture.context.load(system)).toThrow(expect.objectContaining({ code: 'CONTEXT_RECORD_LIMIT' }))
  expect(fixture.context.sequence()).toBe(4097)
})

const dependencies: WorkDependency[] = [
  { kind: 'goal', task_id: 'task', request_id: 'upstream-goal', intent_revision: 3 }, { kind: 'work', task_id: 'task', work_id: 'upstream-work', result_revision: 5 },
  { kind: 'artifact', task_id: 'task', artifact_id: 'artifact', artifact_revision: 7 }, { kind: 'resource', task_id: 'task', resource_id: 'immutable-resource' }
]
it('returns copied exact granted references without loading dependency bodies or sibling history', () => {
  const fixture = setup(); grants(fixture, dependencies)
  fixture.record('model.response', response('PRIVATE DEPENDENCY HISTORY'), { ...owner, work_id: 'upstream-work', attempt_id: 'upstream-attempt' })
  const navigation = fixture.context.navigation(dependencies)
  expect(navigation).toEqual(dependencies)
  expect(JSON.stringify(navigation)).not.toContain('PRIVATE')
  Object.assign(navigation[1]!, { result_revision: 99 })
  expect(fixture.context.navigation(dependencies)).toEqual(dependencies)
  expect(fixture.context.navigation([dependencies[3]!])).toEqual([dependencies[3]])
  expect(fixture.context.load(system)).toEqual([system])
})

it.each([
  [{ kind: 'work', task_id: 'task', work_id: 'upstream-work', result_revision: 6 }],
  [{ kind: 'artifact', task_id: 'task', artifact_id: 'artifact', artifact_revision: 8 }],
  [{ kind: 'resource', task_id: 'other-task', resource_id: 'immutable-resource' }],
  [{ kind: 'resource', task_id: 'task', resource_id: 'different-resource' }],
  [{ kind: 'resource', task_id: 'task', resource_id: 'immutable-resource', body: 'PRIVATE BODY' }],
  [dependencies[0], dependencies[0]]
].map(requested => ({ requested })))('rejects changed, cross-Task, unknown or repeated dependency grants', ({ requested }) => {
  const fixture = setup(); grants(fixture, dependencies)
  expect(() => fixture.context.navigation(requested as WorkDependency[])).toThrow(expect.objectContaining({ code: 'WORKER_DEPENDENCY_DENIED', message: 'Worker dependency is outside the granted input set' }))
})

it.each(['current-attempt', 'work-inputs', 'work-goal', 'attempt-goal'] as const)('revalidates the persisted %s before exposing dependency navigation', reason => {
  const fixture = setup(); grants(fixture, dependencies)
  const table = reason === 'attempt-goal' ? 'runner_attempts' : 'runner_work'
  const value = JSON.parse((fixture.db.prepare(`SELECT payload_json FROM ${table}`).get() as { payload_json: string }).payload_json)
  if (reason === 'current-attempt') value.current_attempt_id = 'different-attempt'
  else if (reason === 'work-inputs') value.dependencies = []
  else value.request_id = 'different-goal'
  fixture.db.prepare(`UPDATE ${table} SET payload_json=?`).run(JSON.stringify(value))
  expect(() => fixture.context.navigation(dependencies)).toThrow(expect.objectContaining({ code: 'WORKER_DEPENDENCY_DENIED' }))
})

it('bounds dependency navigation without truncating version or identity fields', () => {
  const fixture = setup(), many: WorkDependency[] = Array.from({ length: 512 }, (_, index) => ({ kind: 'resource', task_id: 'task', resource_id: `resource-${index}-` + 'a'.repeat(100) }))
  grants(fixture, many)
  expect(() => fixture.context.navigation(many)).toThrow(expect.objectContaining({ code: 'CONTEXT_RECORD_LIMIT' }))
  expect(fixture.context.navigation([many[0]!])).toEqual([many[0]])
})
