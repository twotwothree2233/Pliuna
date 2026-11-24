import { expect, it, vi } from 'vitest'
import type { ArtifactCandidate, Bundle, ContentPlan, Outline } from '../../src/shared/contracts.generated'
import defaults from '../../src/shared/contracts/development-defaults.json'
import type { ChatMessage, Completion } from '../../src/runtime/model/adapter'
import { RunBudget, runAgent, type AgentHost } from '../../src/runtime/model/agent'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { contractRepresentation, operationContract } from '../../src/runtime/model/operation-contracts'
import { modelReadOptions, modelToolRequest } from '../../src/runtime/model/tool-input'
import { createProducerProfile as makeProducerProfile, materializeProducerDraft, validateProducerDraft, createRouterProfile, ruleRouterOutline, validateProducerBundle, validateProducerResult, type ProducerResult, type ProductionResultBinding } from '../../src/runtime/runner/production-profile'
import { containsProducerResult } from '../../src/runtime/runner/production-result'
import * as contracts from '../../src/shared/validation'

import { producerDraft } from '../helpers/producer-draft'
import type { ProducerProfileInput } from '../../src/runtime/runner/production-profile'
function createProducerProfile(input: ProducerProfileInput) {
  return makeProducerProfile({ ...input, normalize: input.normalize ?? (draft => materializeProducerDraft(draft, input, draft.artifacts.map((artifact, index) => ({ artifact_id: artifact.output_key ?? artifact.artifact_id!, candidate_id: `candidate-${index}` })))) })
}

function source(role: ProductionResultBinding['work']['role'] = 'producer'): ProductionResultBinding {
  const goal: ContentPlan = { task_id: 'task', request_id: 'goal', intent_revision: 1, input_event_id: 'input', state: 'active', requirements: [{ requirement_id: 'answer', kind: 'answer', required: true, provenance_required: false }] }
  return {
    goal,
    owner: { task_id: 'task', request_id: 'goal', intent_revision: 1, purpose: 'production', run_id: 'run', work_id: 'work', attempt_id: 'attempt', role },
    work: { task_id: 'task', request_id: 'goal', intent_revision: 1, purpose: 'production', run_id: 'run', work_id: 'work', role, plan_revision: 1, state: 'running', current_attempt_id: 'attempt', requirement_ids: ['answer'], required: true, max_attempts: 2, dependencies: [{ kind: 'goal', task_id: 'task', request_id: 'goal', intent_revision: 1 }] },
    sections: [{ section_id: 'section', request_id: 'goal', intent_revision: 1, position_revision: 1, order_key: 'first' }]
  }
}
function artifactSource(role: ProductionResultBinding['work']['role'] = 'producer'): ProductionResultBinding {
  const value = source(role)
  value.goal.requirements.push({ requirement_id: 'document', kind: 'artifact', required: true, provenance_required: true })
  value.work.requirement_ids.push('document')
  return value
}
function candidate(fields: Partial<ArtifactCandidate> = {}): ArtifactCandidate {
  return { task_id: 'task', request_id: 'goal', intent_revision: 1, run_id: 'run', work_id: 'work', attempt_id: 'attempt', plan_revision: 1, dependencies: [{ kind: 'goal', task_id: 'task', request_id: 'goal', intent_revision: 1 }], artifact_id: 'artifact', candidate_id: 'candidate-0', base_artifact_revision: 0, bundle_resource_id: 'bundle-resource', section_id: 'section', section_position_revision: 1, order_key: 'first', presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: 'task', kind: 'record', id: 'original-evidence' }, requirement_ids: ['document'], unresolved: [], ...fields }
}
function result(fields: Partial<ProducerResult> = {}): ProducerResult {
  return { version: 1, complete: true, answer: 'Result explanation', artifacts: [candidate()], requirement_ids: ['answer', 'document'], unresolved: [], ...fields }
}
const final = (text: string): Completion => ({ text, finish: 'stop', calls: [] })

it('binds draft identities through the host without exposing execution metadata to the model', () => {
  const input = artifactSource(), raw = producerDraft(result()), formal = result()
  const normalize = vi.fn(() => formal), response = final(JSON.stringify(raw))
  expect(makeProducerProfile({ ...input, normalize }).parseResult(response)).toEqual(formal)
  expect(normalize).toHaveBeenCalledExactlyOnceWith(raw, response)
  expect(raw.artifacts[0]).toMatchObject({ output_key: 'artifact' })
  for (const key of ['candidate_id', 'artifact_id', 'task_id', 'run_id', 'attempt_id', 'dependencies']) expect(raw.artifacts[0]).not.toHaveProperty(key)
})

it('accepts explicit updates and rejects ambiguous or repeated draft identities before host binding', () => {
  const input = artifactSource(), raw = producerDraft(result()), body = raw.artifacts[0]!
  const { output_key: _key, ...metadata } = body
  const updated = { ...raw, artifacts: [{ ...metadata, artifact_id: 'existing', base_artifact_revision: 3 }] }
  expect(validateProducerDraft(updated, input)).toEqual(updated)
  const invalid = [
    { ...raw, artifacts: [body, body] },
    { ...raw, artifacts: [{ ...body, artifact_id: 'existing', base_artifact_revision: 3 }] },
    { ...raw, artifacts: [{ ...metadata, artifact_id: 'missing-baseline' }] },
    { ...raw, artifacts: [{ ...metadata, artifact_id: 'existing', base_artifact_revision: 0 }] },
    { ...updated, artifacts: [updated.artifacts[0], updated.artifacts[0]] },
    { ...raw, artifacts: [{ ...body, candidate_id: 'model-candidate' }] },
    { ...raw, artifacts: [{ ...body, attempt_id: 'model-attempt' }] }
  ]
  const normalize = vi.fn(), profile = makeProducerProfile({ ...input, normalize })
  for (const value of invalid) expect(() => profile.parseResult(final(JSON.stringify(value)))).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
  expect(normalize).not.toHaveBeenCalled()
})
function bundle(): Bundle {
  return { profile: 'managed-v1', html: '<article>Result</article>', css: '', state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: '1' }, forms: [], behaviors: [], references: [], export: [] }
}
function currentOutline(): Outline {
  return { task_id: 'task', outline_revision: 3, base_outline_revision: 2, sections: [{ section_id: 'unrelated', request_id: 'other-goal', intent_revision: 2, order_key: 'earlier', position_revision: 4, title: 'Keep this section' }, ...source().sections] }
}

it.each(['producer', 'lightweight', 'integrator'] as const)('normalizes a plain %s answer without choosing delivery from its role', role => {
  const profile = createProducerProfile(source(role))
  expect(profile.id).toBe(`${role}-output-v1`)
  expect(profile.role).toBe(role)
  expect(profile.parseResult(final('42'))).toEqual({ version: 1, complete: true, answer: '42', artifacts: [], requirement_ids: ['answer'], unresolved: [] })
})

it('guides an internal text handoff without borrowing the request’s final answer requirement', () => {
  const input = artifactSource()
  if (input.work.purpose !== 'production') throw Error('Expected production work')
  input.work.requirement_ids = []
  input.work.assignment = { instructions: 'Summarize the bound evidence for downstream work.', inputs: [], outputs: [{ output_key: 'evidence', kind: 'answer' }] }
  const profile = createProducerProfile(input)
  const text = 'Node.js 20 End: 2026-04-30. RISK-NODE20-EOL.'
  expect(profile.system).toContain('Return the assigned text directly as plain text.')
  expect(profile.resultCorrection).toContain('assigned requirement_ids []')
  expect(profile.system).not.toContain('For artifact construction')
  expect(profile.resultCorrection).not.toContain('complete draft JSON')
  const accepted = { version: 1, complete: true, answer: text, artifacts: [], requirement_ids: [], unresolved: [] }
  expect(profile.parseResult(final(text))).toEqual(accepted)
  expect(() => profile.parseResult(final(JSON.stringify({ ...accepted, requirement_ids: ['answer'] })))).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
})

it('guides a publishing assignment to return a card without chat text or display titles as resource keys', () => {
  const input = artifactSource()
  if (input.work.purpose !== 'production') throw Error('Expected production work')
  input.work.requirement_ids = ['document']
  input.work.assignment = { instructions: 'Publish the decision card.', inputs: [], outputs: [{ output_key: 'artifact', kind: 'artifact', exposure: 'publish' }] }
  const profile = createProducerProfile(input)
  expect(profile.system).toContain('Set answer to null.')
  expect(profile.system).toContain('Use references:[] when no local resource is embedded.')
  expect(profile.system).toContain('never display titles')
  const accepted = result({ answer: null, requirement_ids: ['document'] })
  expect(profile.parseResult(final(JSON.stringify(producerDraft(accepted))))).toEqual(accepted)
})

it('keeps artifact, content-check and provenance requirements unresolved for ordinary text', () => {
  const input = artifactSource('lightweight')
  input.goal.requirements.push({ requirement_id: 'check', kind: 'content_check', required: true, provenance_required: false }, { requirement_id: 'cited', kind: 'answer', required: true, provenance_required: true })
  input.work.requirement_ids.push('check', 'cited')
  expect(createProducerProfile(input).parseResult(final('A partial answer'))).toMatchObject({ requirement_ids: ['answer'], artifacts: [], unresolved: ['document', 'check', 'cited'].map(requirement_id => ({ task_id: 'task', request_id: 'goal', intent_revision: 1, requirement_id })) })
})

it('validates a full candidate set and retains exact resource and dependency references', () => {
  const input = artifactSource(), raw = result({ artifacts: [candidate(), candidate({ artifact_id: 'second-fragment', candidate_id: 'candidate-1', bundle_resource_id: 'second-resource', width_constraint: 'flexible' })] })
  const parsed = createProducerProfile(input).parseResult(final(JSON.stringify(producerDraft(raw))))
  expect(parsed).toEqual(raw)
  expect(parsed).not.toBe(raw)
  raw.artifacts[0]!.title = 'Changed after parsing'
  expect(parsed.artifacts[0]!.title).toBeUndefined()
  expect(parsed.artifacts.map(item => item.bundle_resource_id)).toEqual(['bundle-resource', 'second-resource'])
})

it('decodes one exact production result surrounded by prose or a JSON fence', () => {
  const raw = result(), encoded = JSON.stringify(producerDraft(raw)), profile = createProducerProfile(artifactSource())
  for (const text of [`Prepared output:\n${encoded}\nComplete.`, `我已制作讲义。\n\`\`\`json\n${encoded}\n\`\`\`\n请阅读。`]) {
    expect(profile.parseResult(final(text))).toEqual(raw)
  }
})

it('preserves ordinary prose and unrelated JSON examples', () => {
  const profile = createProducerProfile(source())
  for (const text of ['The managed-v1 resource ID is part of this explanation.', 'Example:\n```json\n{"version":1,"artifacts":[]}\n```', 'The marker `</｜DSML｜ calls>` ends a tool block.']) {
    expect(profile.parseResult(final(text)).answer).toBe(text)
    expect(containsProducerResult(text)).toBe(false)
  }
})

it.each(['\n</｜DSML｜ calls>', '<|DSML| calls>\n</|DSML| calls>'])('rejects isolated tool protocol markup in both answer formats: %j', text => {
  const profile = createProducerProfile(source())
  for (const response of [text, JSON.stringify({ ...result(), answer: text, artifacts: [], requirement_ids: ['answer'] })]) {
    expect(() => profile.parseResult(final(response))).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
  }
})

it.each(['version', 'complete', 'answer', 'artifacts', 'requirement_ids', 'unresolved'])('rejects an embedded production protocol missing %s', field => {
  const raw: Record<string, unknown> = { ...result() }
  delete raw[field]
  const text = `Prepared output:\n${JSON.stringify(raw)}`
  expect(containsProducerResult(text)).toBe(true)
  expect(() => createProducerProfile(artifactSource()).parseResult(final(text))).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
})

it('recognizes malformed protocol keys and truncated or conflicting result envelopes', () => {
  const encoded = JSON.stringify(result()), profile = createProducerProfile(artifactSource())
  const unquoted = '{version:1,complete:true,answer:"Result",artifacts:[],requirement_ids:["answer"],unresolved:[]}'
  for (const text of [`制作说明。\n${unquoted}`, `Prepared output:\n${encoded.slice(0, -1)}`, 'Prepared output:\n{"version":1,"complete":true,"answer":null,"artifacts":[', `First:\n${encoded}\nSecond:\n${encoded}`]) {
    expect(containsProducerResult(text)).toBe(true)
    expect(() => profile.parseResult(final(text))).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
  }
})

it('does not combine unrelated object fields or inspect JSON string contents as an envelope', () => {
  expect(containsProducerResult('{version:1,complete:true} {answer:"x",artifacts:[]} {requirement_ids:[],unresolved:[]}')).toBe(false)
  expect(containsProducerResult(JSON.stringify({ description: JSON.stringify(result()) }))).toBe(false)
})

it('rejects a result whose learner answer embeds another production protocol', () => {
  const raw = result({ answer: `Prepared output:\n${JSON.stringify(result())}` })
  expect(() => createProducerProfile(artifactSource()).parseResult(final(JSON.stringify(producerDraft(raw))))).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
})

it('requires a result envelope after attempting a managed bundle without restricting ordinary resources', () => {
  const profile = createProducerProfile(artifactSource())
  profile.authorize({ type: 'write', input: { type: 'resource.create', display_name: 'Lecture', content: { type: 'json', value: bundle() } } })
  expect(() => profile.parseResult(final('I created the lecture.'))).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
  expect(profile.parseResult(final(JSON.stringify(producerDraft(result()))))).toEqual(result())
  const ordinary = createProducerProfile(source())
  ordinary.authorize({ type: 'write', input: { type: 'resource.create', display_name: 'Data', content: { type: 'json', value: { data: 'ordinary' } } } })
  expect(ordinary.parseResult(final('Saved the data.')).answer).toBe('Saved the data.')
})

it('requires every assigned requirement to be covered or explicitly unresolved', () => {
  const input = artifactSource(), missing = { task_id: 'task', request_id: 'goal', intent_revision: 1, requirement_id: 'document' }
  expect(validateProducerResult(result({ artifacts: [], requirement_ids: ['answer'], unresolved: [missing] }), input)).toMatchObject({ unresolved: [missing] })
  expect(() => validateProducerResult(result({ artifacts: [], requirement_ids: ['answer'] }), input)).toThrow()
  expect(() => validateProducerResult(result({ artifacts: [], requirement_ids: ['answer', 'document'] }), input)).toThrow()
  expect(() => validateProducerResult(result({ answer: null }), input)).toThrow()
  expect(() => validateProducerResult(result({ requirement_ids: ['answer', 'document'], unresolved: [missing] }), input)).toThrow()
})

it('requires answer content even when an artifact declares answer coverage', () => {
  const input = source(), raw = result({ artifacts: [candidate({ requirement_ids: ['answer'] })], requirement_ids: ['answer'] })
  expect(() => validateProducerResult({ ...raw, answer: null }, input)).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
  expect(() => validateProducerResult({ ...raw, answer: '   ' }, input)).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
  expect(validateProducerResult(raw, input)).toEqual(raw)
})

it.each([
  { task_id: 'other-task' }, { request_id: 'other-goal' }, { run_id: 'other-run' }, { work_id: 'sibling-work' }, { attempt_id: 'old-attempt' },
  { intent_revision: 2 }, { plan_revision: 2 }, { section_id: 'other-section' }, { section_position_revision: 2 }, { order_key: 'later' },
  { dependencies: [] }, { requirement_ids: ['unassigned'] },
  { unresolved: [{ task_id: 'task', request_id: 'other-goal', intent_revision: 1, requirement_id: 'document' }] }
])('rejects a candidate with a changed source or input binding %j', fields => {
  expect(() => validateProducerResult(result({ artifacts: [candidate(fields)] }), artifactSource())).toThrow()
})

it('rejects duplicate fragments, candidate identities and hidden missing requirements', () => {
  const input = artifactSource(), missing = { task_id: 'task', request_id: 'goal', intent_revision: 1, requirement_id: 'document' }
  expect(() => validateProducerResult(result({ artifacts: [candidate(), candidate({ candidate_id: 'other-candidate' })] }), input)).toThrow()
  expect(() => validateProducerResult(result({ artifacts: [candidate(), candidate({ artifact_id: 'other-artifact' })] }), input)).toThrow()
  expect(() => validateProducerResult(result({ artifacts: [candidate({ requirement_ids: [], unresolved: [missing] })] }), input)).toThrow()
  expect(() => validateProducerResult(result({ artifacts: [], requirement_ids: ['answer'], unresolved: [missing, missing] }), input)).toThrow()
  expect(() => validateProducerResult(result({ artifacts: [], requirement_ids: ['answer', 'answer'], unresolved: [missing] }), input)).toThrow()
})

it.each([
  '{"version":1,"PRIVATE BODY":true}', '{"version":1,', '[]', '```json\n{}\n```',
  JSON.stringify({ ...result(), complete: false }), JSON.stringify({ ...result(), preview: 'PRIVATE BODY' })
])('does not downgrade malformed structured output into a final answer', text => {
  const profile = createProducerProfile(artifactSource())
  expect(() => profile.parseResult(final(text))).toThrow()
  try { profile.parseResult(final(text)) } catch (error) { expect((error as Error).message).not.toContain('PRIVATE BODY') }
})

it('requires a nonempty terminal response without unresolved tool calls', () => {
  const profile = createProducerProfile(source())
  expect(() => profile.parseResult(final('   '))).toThrow()
  expect(() => profile.parseResult({ ...final('Answer'), finish: 'tool_calls' })).toThrow()
  expect(() => profile.parseResult({ ...final('Answer'), calls: [{ id: 'pending', type: 'function', function: { name: 'read', arguments: '{}' } }] })).toThrow()
})

it('bounds the complete normalized answer record at one MiB including JSON escaping', () => {
  const profile = createProducerProfile(source()), overhead = Buffer.byteLength(JSON.stringify(profile.parseResult(final('a')))) - 1
  const text = 'a'.repeat(1048576 - overhead)
  expect(Buffer.byteLength(JSON.stringify(profile.parseResult(final(text))))).toBe(1048576)
  expect(() => profile.parseResult(final(`${text}a`))).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
  expect(() => profile.parseResult(final('"'.repeat(600000)))).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
})

it('captures immutable source and exact grants before execution', () => {
  const input = source(), ids = ['allowed-resource'], grants = [{ type: 'read' as const, kind: 'resource', ids }]
  const profile = createProducerProfile({ ...input, grants })
  input.owner.attempt_id = 'new-attempt'; input.goal.requirements[0]!.requirement_id = 'changed'; input.work.requirement_ids.length = 0; ids.push('private-resource')
  expect(profile.parseResult(final('Answer')).requirement_ids).toEqual(['answer'])
  expect(() => profile.authorize(modelToolRequest('read', { kind: 'resource', id: 'allowed-resource' }))).not.toThrow()
  expect(() => profile.authorize(modelToolRequest('read', { kind: 'resource', id: 'private-resource' }))).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
})

it.each(['producer', 'lightweight', 'integrator'] as const)('authorizes every documented contract discovery call for a %s', role => {
  const profile = createProducerProfile(source(role))
  expect(profile.tools.map(tool => tool.function.name)).toEqual(['list', 'read', 'write'])
  const calls: { name: string; arguments: Record<string, unknown> }[] = profile.system.split('\n').filter(line => line.startsWith('{"name":')).map(line => JSON.parse(line))
  expect(calls).toHaveLength(6)
  const representations: unknown[] = []
  for (const call of calls) {
    const request = modelToolRequest(call.name, call.arguments)
    expect(() => profile.authorize(request)).not.toThrow()
    if (request.type === 'read') {
      const contract = operationContract(request.input.target.id)
      expect(contract).toBeDefined()
      representations.push(contractRepresentation(contract!, modelReadOptions(request)!.selection))
    }
  }
  expect(representations[0]).toMatchObject({ id: 'tool.write' })
  expect(representations[1]).toMatchObject({ id: 'resource.create' })
  expect(representations[2]).toMatchObject({ properties: { profile: { const: 'managed-v1' } } })
  const example = representations[3] as { operation: string; input_json: string }
  expect(example.operation).toBe('surface.update')
  const input = JSON.parse(example.input_json)
  expect(validateProducerBundle(input.operations[0].bundle.bundle)).toMatchObject({ profile: 'managed-v1' })
  expect(representations[4]).toMatchObject({ draft: expect.stringContaining('number/integer fields are strings') })
})

it('provides a static card write example that passes the producer tool contract', () => {
  const profile = createProducerProfile(artifactSource())
  const example = profile.system.split('\n').find(line => line.startsWith('{"operation":"resource.create"'))
  expect(example).toBeDefined()
  const request = modelToolRequest('write', JSON.parse(example!))
  expect(() => profile.authorize(request)).not.toThrow()
  expect(profile.system).toContain('Cite public sources as visible plain text')
})

it('keeps resource and task-data operations while business reads and plugins require explicit grants', () => {
  const profile = createProducerProfile(source())
  const data = { schema: { type: 'object', properties: {}, additionalProperties: false }, value: {}, references: [] }
  for (const input of [
    { type: 'resource.create', display_name: 'Output', content: { type: 'json', value: bundle() } },
    { type: 'task_data.create', data },
    { type: 'task_data.replace', id: 'data', expected_revision: 1, value: {}, references: [] },
    { type: 'task_data.remove', id: 'data', expected_revision: 1 }
  ]) expect(() => profile.authorize({ type: 'write', input })).not.toThrow()
  expect(() => profile.authorize(modelToolRequest('list', { kind: 'resource' }))).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
  expect(() => profile.authorize(modelToolRequest('read', { kind: 'resource', id: 'body' }))).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
  expect(() => profile.authorize(modelToolRequest('read', { kind: 'task_data', id: 'data' }))).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
  expect(() => profile.authorize(modelToolRequest('call', { capability: 'plugin:sample:read', input_json: '{}' }))).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
  const granted = createProducerProfile({ ...source(), grants: [{ type: 'list', kind: 'resource' }, { type: 'read', kind: 'resource', ids: ['body'] }, { type: 'call', capability: 'plugin:sample:read' }] })
  expect(() => granted.authorize(modelToolRequest('read', { kind: 'resource', id: 'body' }))).not.toThrow()
  expect(() => granted.authorize(modelToolRequest('list', { kind: 'resource' }))).not.toThrow()
  expect(() => granted.authorize(modelToolRequest('call', { capability: 'plugin:sample:read', input_json: '{}' }))).not.toThrow()
})

it('refuses shared Surface updates even when a caller explicitly supplies that grant', () => {
  const request = { type: 'write', input: { type: 'surface.update', surface_id: 'surface', expected_revision: 1, operations: [{ type: 'view.create', client_ref: 'output', slot_id: 'main', bundle: { type: 'inline', bundle: bundle() } }] } }
  const grants = [{ type: 'write' as const, operation: 'surface.update' }]
  for (const profile of [createProducerProfile({ ...source(), grants }), createRouterProfile({ ...source('router'), grants })]) {
    expect(() => profile.authorize(request)).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
  }
})

it('enforces the existing 256 KiB per-fragment UTF-8 JSON limit at creation and validation', () => {
  const value = bundle()
  value.html = '<article>界</article>'
  value.css = ' '.repeat(defaults.surface.inline_bundle_bytes - Buffer.byteLength(JSON.stringify(value)))
  expect(Buffer.byteLength(JSON.stringify(validateProducerBundle(value)))).toBe(262144)
  const profile = createProducerProfile(source())
  expect(() => profile.authorize({ type: 'write', input: { type: 'resource.create', display_name: 'Fragment', content: { type: 'json', value } } })).not.toThrow()
  value.css += ' '
  expect(() => validateProducerBundle(value)).toThrow(expect.objectContaining({ code: 'BUNDLE_SIZE_LIMIT' }))
  expect(() => profile.authorize({ type: 'write', input: { type: 'resource.create', display_name: 'Fragment', content: { type: 'json', value } } })).toThrow(expect.objectContaining({ code: 'BUNDLE_SIZE_LIMIT' }))
  expect(() => validateProducerBundle(bundle())).not.toThrow()
})

it('retains bundle reference diagnostics for validation and creation without accepting flat targets', () => {
  const value = { ...bundle(), html: '<article>PRIVATE BODY</article>', references: [{ kind: 'resource', id: 'source-resource', name: 'source.md' }] }
  let original: unknown
  try { contracts.validateBundle(value) } catch (error) { original = error }
  expect(original).toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringContaining('data/references/0') })
  if (!(original instanceof contracts.ContractError)) throw Error('Expected a bundle contract error')
  const profile = createProducerProfile(artifactSource())
  const request = modelToolRequest('write', { operation: 'resource.create', input: { display_name: 'Output', content: { type: 'json', value } } })
  for (const check of [() => validateProducerBundle(value), () => profile.authorize(request)]) {
    expect(check).toThrow(expect.objectContaining({ code: original.code, message: original.message, suggestion: JSON.stringify({ name: 'read', arguments: { kind: 'object_type', id: 'resource.create', selection: { view: 'schema', section: 'bundle' } } }) }))
    expect(check).toThrow(expect.objectContaining({ message: expect.not.stringContaining('PRIVATE BODY') }))
  }
})

it('accepts empty references and explicit immutable targets without rewriting them', () => {
  const references: Bundle['references'][] = [[], [{ name: 'source', target: { kind: 'resource', id: 'source-resource' } }]]
  for (const declared of references) {
    const value = { ...bundle(), references: declared }, profile = createProducerProfile(artifactSource())
    expect(validateProducerBundle(value)).toEqual(value)
    expect(() => profile.authorize(modelToolRequest('write', { operation: 'resource.create', input: { display_name: 'Output', content: { type: 'json', value } } }))).not.toThrow()
  }
})

it('retains export validation errors without echoing bundle content', () => {
  const value = bundle()
  value.html = '<article id="outer"><p id="inner">PRIVATE BODY</p></article>'
  value.export = [{ id: 'first', category: 'learning', source: { type: 'element', element_id: 'outer' } }, { id: 'second', category: 'learning', source: { type: 'element', element_id: 'inner' } }]
  expect(() => validateProducerBundle(value)).toThrow(expect.objectContaining({ code: 'EXPORT_FRAGMENT_OVERLAP', message: 'Export roots cannot overlap' }))
  value.export = [{ id: 'missing', category: 'learning', source: { type: 'element', element_id: 'missing' } }]
  expect(() => validateProducerBundle(value)).toThrow(expect.objectContaining({ code: 'EXPORT_FRAGMENT_INVALID', message: 'Missing or duplicate export root' }))
  expect(() => validateProducerBundle({ ...bundle(), body: 'PRIVATE BODY' })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST', message: expect.not.stringContaining('PRIVATE BODY') }))
  expect(() => validateProducerBundle({ ...bundle(), state: { ...bundle().state, initial: { count: Infinity } } })).toThrow()
})

it('propagates unexpected bundle validator failures unchanged', () => {
  const failure = new Error('Unexpected validator failure'), validator = vi.spyOn(contracts, 'validateBundle').mockImplementationOnce(() => { throw failure })
  let received: unknown
  try { validateProducerBundle(bundle()) } catch (error) { received = error }
  finally { validator.mockRestore() }
  expect(received).toBe(failure)
})

it('creates a stable default section without invoking a model or changing unrelated sections', () => {
  const input = source(), initial = ruleRouterOutline(input.goal, null, { order_key: 'ordered', title: 'Result' })
  expect(initial).toEqual({ task_id: 'task', outline_revision: 1, base_outline_revision: 0, sections: [{ section_id: 'goal', request_id: 'goal', intent_revision: 1, order_key: 'ordered', position_revision: 1, title: 'Result' }] })
  expect(ruleRouterOutline(input.goal, initial, { order_key: 'ignored-new-order', title: 'Ignored new title' })).toEqual(initial)
  const current: Outline = { task_id: 'task', outline_revision: 2, base_outline_revision: 1, sections: [currentOutline().sections[0]!] }
  const next = ruleRouterOutline(input.goal, current)
  expect(next.outline_revision).toBe(3)
  expect(next.sections[0]).toEqual(current.sections[0])
  expect(next.sections[1]?.section_id).toBe('goal')
  expect(current.sections).toHaveLength(1)
})

it('updates only an owned goal revision while retaining section identity and position', () => {
  const input = source(), current = currentOutline()
  input.goal = { ...input.goal, intent_revision: 2, previous_revision: 1 }
  const next = ruleRouterOutline(input.goal, current)
  expect(next).toMatchObject({ outline_revision: 4, base_outline_revision: 3 })
  expect(next.sections[0]).toEqual(current.sections[0])
  expect(next.sections[1]).toEqual({ ...current.sections[1], intent_revision: 2 })
  expect(next.sections[1]?.position_revision).toBe(1)
  expect(next.sections[1]?.section_id).toBe('section')
})

it('rejects invalid default-outline ownership, collisions and revision regression', () => {
  const input = source(), current = currentOutline()
  expect(() => ruleRouterOutline(input.goal, { ...current, task_id: 'other-task' })).toThrow()
  expect(() => ruleRouterOutline({ ...input.goal, state: 'withdrawn' }, current)).toThrow()
  expect(() => ruleRouterOutline(input.goal, { ...current, sections: [{ ...current.sections[0]!, section_id: 'goal' }] })).toThrow()
  expect(() => ruleRouterOutline(input.goal, { ...current, sections: [{ ...current.sections[1]!, intent_revision: 2 }] })).toThrow()
})

it('validates Router outline proposals while preserving unrelated section metadata', () => {
  const input = source('router'), current = currentOutline(), profile = createRouterProfile({ ...input, outline: current })
  expect(profile.id).toBe('router-outline-v1')
  expect(profile.tools).toEqual([])
  expect(profile.parseResult(final(JSON.stringify({ version: 1, outline: current })))).toEqual({ version: 1, outline: current })
  const next: Outline = { ...current, outline_revision: 4, base_outline_revision: 3, sections: [...current.sections, { section_id: 'new-section', request_id: 'goal', intent_revision: 1, position_revision: 1, order_key: 'last' }] }
  expect(profile.parseResult(final(JSON.stringify({ version: 1, outline: next })))).toEqual({ version: 1, outline: next })
  next.sections[0] = { ...next.sections[0]!, title: 'Changed unrelated section' }
  expect(() => profile.parseResult(final(JSON.stringify({ version: 1, outline: next })))).toThrow()
})

it('requires correct Router position successors and rejects omitted, stale or invented sections', () => {
  const input = source('router'), current = currentOutline(), profile = createRouterProfile({ ...input, outline: current })
  const next: Outline = { ...current, outline_revision: 4, base_outline_revision: 3, sections: structuredClone(current.sections) }
  next.sections[1]!.order_key = 'moved'
  expect(() => profile.parseResult(final(JSON.stringify({ version: 1, outline: next })))).toThrow()
  next.sections[1]!.position_revision++
  expect(() => profile.parseResult(final(JSON.stringify({ version: 1, outline: next })))).not.toThrow()
  next.sections = [next.sections[1]!]
  expect(() => profile.parseResult(final(JSON.stringify({ version: 1, outline: next })))).toThrow()
  const corrected = source('router')
  corrected.goal.intent_revision = 2; if (corrected.work.purpose === 'production') corrected.work.intent_revision = 2
  if (corrected.owner.purpose === 'production') corrected.owner.intent_revision = 2
  const correction = createRouterProfile({ ...corrected, outline: current })
  expect(() => correction.parseResult(final(JSON.stringify({ version: 1, outline: current })))).toThrow()
  expect(() => createRouterProfile(input).parseResult(final(JSON.stringify({ version: 1, outline: { ...current, outline_revision: 1, base_outline_revision: 0 } })))).toThrow()
})

it('rejects a Collator or mismatched execution source for the production profiles', () => {
  expect(() => createProducerProfile(source('collator'))).toThrow()
  expect(() => createProducerProfile(source('router'))).toThrow()
  expect(() => createRouterProfile(source())).toThrow()
  const input = source(); input.owner.work_id = 'sibling-work'
  expect(() => createProducerProfile(input)).toThrow()
})

it('recovers a rejected bundle by reading the suggested schema before creating its artifact', async () => {
  const input = artifactSource(), selected = createProducerProfile(input), config = { id: 'model', base_url: 'https://example.invalid', wire_model_id: 'synthetic', context_tokens: 100000, max_output_tokens: 4096, compatibility_profile: 'chat-max-tokens' as const }
  const service = new ModelService(), lease: ModelLease = { id: 'model', revision: 1, config, owner: input.owner, release() {} }
  const rejected = { ...bundle(), references: [{ kind: 'resource', id: 'source-resource', name: 'source.md' }] }
  const call = (id: string, name: string, args: unknown): Completion => ({ text: '', finish: 'tool_calls', calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
  const write = (value: unknown) => ({ operation: 'resource.create', input: { display_name: 'Output', content: { type: 'json', value } } })
  let stage = 0
  const requests = vi.spyOn(service, 'request').mockImplementation(async (_lease, _task, messages) => {
    const previous = messages.at(-1)
    switch (stage++) {
      case 0: return call('rejected', 'write', write(rejected))
      case 1: {
        expect(previous?.role).toBe('tool')
        const failure = JSON.parse(previous!.content!)
        expect(failure).toMatchObject({ execution: 'not_executed', error: { code: 'INVALID_REQUEST', message: expect.stringContaining('data/references/0') } })
        const suggestion = JSON.parse(failure.error.suggestion)
        expect(suggestion).toEqual({ name: 'read', arguments: { kind: 'object_type', id: 'resource.create', selection: { view: 'schema', section: 'bundle' } } })
        return call('schema', suggestion.name, suggestion.arguments)
      }
      case 2: {
        expect(previous?.role).toBe('tool')
        const schema = JSON.parse(previous!.content!).data
        expect(schema).toMatchObject({ properties: { references: { $ref: '#/$defs/references' } }, $defs: { reference: { required: ['name', 'target'], additionalProperties: false } } })
        return call('corrected', 'write', write(bundle()))
      }
      case 3: return final(JSON.stringify(producerDraft(result())))
      default: throw Error('Unexpected model retry')
    }
  })
  const installed = vi.fn(), records: { kind: string; payload: Record<string, unknown> }[] = []
  const host: AgentHost = {
    valid() {}, state() {}, budget() {}, record(kind, payload) { records.push({ kind, payload }) },
    tool: vi.fn(async raw => {
      const request = contracts.validateModel(raw)
      selected.authorize(request)
      if (request.type === 'read') {
        const contract = operationContract(request.input.target.id)
        return { request_type: 'read', execution: 'success', delivery: 'delivered', truncated: false, data: contractRepresentation(contract!, modelReadOptions(request)!.selection) }
      }
      expect(request).toMatchObject({ type: 'write', input: { type: 'resource.create', content: { value: { references: [] } } } })
      return { request_type: 'write', execution: 'success', delivery: 'delivered', truncated: false, data: { id: 'bundle-resource' } }
    })
  }
  try {
    await runAgent(service, lease, 'task', [{ role: 'user', content: 'Produce the requested document' }], host, new AbortController().signal, new RunBudget(config), { profile: selected, onResult: installed })
    expect(installed).toHaveBeenCalledExactlyOnceWith(result())
    expect(host.tool).toHaveBeenCalledTimes(2)
    expect(records.filter(item => item.kind === 'model.tool_result')).toHaveLength(3)
    expect(requests).toHaveBeenCalledTimes(4)
  } finally { requests.mockRestore() }
})

it('corrects draft identity and rejects supplied execution metadata without replaying resource creation', async () => {
  const input = artifactSource(), selected = createProducerProfile(input), config = { id: 'model', base_url: 'https://example.invalid', wire_model_id: 'synthetic', context_tokens: 100000, max_output_tokens: 4096, compatibility_profile: 'chat-max-tokens' as const }
  const service = new ModelService(), lease: ModelLease = { id: 'model', revision: 1, config, owner: input.owner, release() {} }
  const write = { id: 'create-bundle', type: 'function' as const, function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input_json: JSON.stringify({ display_name: 'Fragment', content: { type: 'json', value: bundle() } }) }) } }
  const invalidRevision = { ...result(), artifacts: [{ ...candidate(), base_artifact_revision: null }] }
  const invalidDependencies = { ...producerDraft(result()), artifacts: [{ ...producerDraft(result()).artifacts[0], dependencies: input.work.dependencies }] }
  const responses: Completion[] = [{ text: '', finish: 'tool_calls', calls: [write] }, final(JSON.stringify(invalidRevision)), final(JSON.stringify(invalidDependencies)), final(JSON.stringify(producerDraft(result())))]
  const history: ChatMessage[][] = [], installed = vi.fn()
  const requests = vi.spyOn(service, 'request').mockImplementation(async (currentLease, task, messages, tools, _signal, _onText, _limit, onStart) => {
    expect(currentLease).toBe(lease); expect(task).toBe('task'); expect(tools).toEqual(selected.tools)
    history.push(structuredClone(messages))
    expect(installed).not.toHaveBeenCalled()
    onStart?.(); return responses.shift()!
  })
  const records: { kind: string; payload: Record<string, unknown> }[] = []
  const host: AgentHost = {
    valid() {}, state() {}, budget() {}, record(kind, payload) { records.push({ kind, payload }) },
    // Compaction retains the first system message and can discard later ones.
    async context(messages) { return messages.filter((message, index) => index === 0 || message.role !== 'system') },
    tool: vi.fn(async request => { selected.authorize(request); return { request_type: 'write', execution: 'success', delivery: 'delivered', truncated: false, data: { id: 'bundle-resource' } } })
  }
  const budget = new RunBudget(config)
  try {
    await runAgent(service, lease, 'task', [{ role: 'user', content: 'Produce the requested document' }], host, new AbortController().signal, budget, { profile: selected, onResult: installed })
    expect(installed).toHaveBeenCalledExactlyOnceWith(result())
    expect(requests).toHaveBeenCalledTimes(4)
    const correction = history[2]!
    expect(correction[0]?.role).toBe('system')
    expect(correction[0]?.content).toContain(selected.system)
    expect(correction[0]?.content).toContain(selected.resultCorrection)
    expect(selected.resultCorrection).toContain('section_id from ["section"]')
    expect(selected.resultCorrection).toContain('Do not supply candidate IDs or execution metadata')
    expect(selected.resultCorrection).toContain('New artifacts use output_key')
    expect(correction).toContainEqual({ role: 'assistant', content: JSON.stringify(invalidRevision) })
    expect(correction.filter(message => message.role === 'tool')).toHaveLength(1)
    expect(history[3]).toContainEqual({ role: 'assistant', content: JSON.stringify(invalidDependencies) })
    expect(host.tool).toHaveBeenCalledOnce()
    expect(records.filter(item => item.kind === 'model.tool_result')).toHaveLength(1)
    expect(records.find(item => item.kind === 'model.tool_result')?.payload.message).toMatchObject({ tool_call_id: 'create-bundle' })
    expect(records.filter(item => item.kind === 'worker.result.rejected')).toEqual(Array.from({ length: 2 }, () => ({ kind: 'worker.result.rejected', payload: { code: 'INVALID_WORKER_RESULT' } })))
    expect(records.filter(item => item.kind === 'message.assistant').map(item => item.payload.text)).toEqual([JSON.stringify(producerDraft(result()))])
    expect(budget.state).toMatchObject({ model_requests: 4, tool_requests: 1 })
  } finally { requests.mockRestore() }
})

it.each([false, true])('stops repeated invalid results even when JSON keys are reordered: %s', async reordered => {
  const selected = createProducerProfile(artifactSource()), config = { id: 'model', base_url: 'https://example.invalid', wire_model_id: 'synthetic', context_tokens: 100000, max_output_tokens: 4096, compatibility_profile: 'chat-max-tokens' as const }
  const service = new ModelService(), lease: ModelLease = { id: 'model', revision: 1, config, release() {} }
  const rejected = { ...result(), artifacts: [{ ...candidate(), base_artifact_revision: null }] }
  const reverseKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseKeys) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)])) : value
  const responses = [final(JSON.stringify(rejected)), final(JSON.stringify(reordered ? reverseKeys(rejected) : rejected))]
  const requests = vi.spyOn(service, 'request').mockImplementation(async () => responses.shift()!)
  const installed = vi.fn(), records = vi.fn()
  const host: AgentHost = { valid() {}, state() {}, budget() {}, record: records, tool: vi.fn() }
  try {
    await expect(runAgent(service, lease, 'task', [], host, new AbortController().signal, undefined, { profile: selected, onResult: installed })).rejects.toMatchObject({ code: 'INVALID_WORKER_RESULT' })
    expect(requests).toHaveBeenCalledTimes(2)
    expect(installed).not.toHaveBeenCalled()
    expect(host.tool).not.toHaveBeenCalled()
    expect(records.mock.calls.filter(([kind]) => kind === 'worker.result.rejected')).toHaveLength(1)
    expect(records.mock.calls.some(([kind]) => kind === 'message.assistant')).toBe(false)
  } finally { requests.mockRestore() }
})
