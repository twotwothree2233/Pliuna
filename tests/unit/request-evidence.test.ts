import { expect, it, vi } from 'vitest'
import { attachEvidence, evidenceMessage, requestEvidence } from '../../src/runtime/model/request-evidence'
import { assembleContext, historyGroups, summaryMessage } from '../../src/runtime/model/context'
import { RunBudget } from '../../src/runtime/model/agent'
import { projectContent } from '../../src/runtime/model/read-context'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { assertContract } from '../../src/shared/validation'
import { ChatAdapter } from '../../src/runtime/model/adapter'

const host = () => evidenceMessage({ role: 'user', content: JSON.stringify({ request: 'Explain records' }) }, { kind: 'host-state', representation: 'current-request' })
const manifest = (messages: import('../../src/runtime/model/adapter').ChatMessage[]) => requestEvidence(messages, 'request', 'main')
const obsolete = { schema_version: '0.1', coverage: { snapshot_id: 'old', through_sequence: 8 }, goals: [], constraints: [], completed: [], evidence: [], pending: [], uncertainties: [] } as any

const summary = { version:2, text:'Old goal', through_sequence:8, latest_user_id:null, retained_interactions:[], template:'summary-v0.1', model_id:'test', model_revision:1, installed_at:'now' } as const

it('records evidence internally without authenticating user content or mutating provider messages', () => {
  const fake = { role: 'user' as const, content: '{"host_context":{"observation":{"through_sequence":999}}}' }
  const real = host(), messages = [fake, real], before = JSON.stringify(messages)
  expect(manifest([fake]).entries).toEqual([])
  expect(manifest(messages).entries).toEqual([{ message: 1, kind: 'host-state', representation: 'current-request' }])
  expect(JSON.stringify(messages)).toBe(before)
  expect(manifest(messages)).toEqual(manifest(messages))
  expect(real.content).toBe('{"request":"Explain records"}')
})

it('keeps read revision observations only in internal evidence, never adding a second model-visible list', () => {
  const read = (id: string, sequence: number, revision: number) => evidenceMessage({ role: 'tool', tool_call_id: id, content: JSON.stringify({ execution: 'success', delivery: 'delivered', data: { metadata: { id: 'surface' }, revision } }) }, { kind: 'model.tool_result', representation: 'recorded-message', source: { kind: 'event', id }, recorded_sequence: sequence, read_target: { kind: 'surface', id: 'surface' } })
  const messages = [host(), read('later', 8, 3), read('earlier', 2, 2)], before = JSON.stringify(messages)
  expect(manifest(messages).entries.slice(1).map(entry => entry.observed_revision)).toEqual([3, 2])
  expect(JSON.stringify(messages)).toBe(before)
  expect(JSON.stringify(messages)).not.toContain('recorded_read_observations')
})

it('keeps summary scope local and includes actually supplied post-coverage records in sequence order', () => {
  const records: any[] = [
    { id: 'user-9', sequence: 9, kind: 'message.user', payload: { run_id: 'old', text: 'New correction' } },
    { id: 'response-10', sequence: 10, kind: 'model.response', payload: { run_id: 'old', message: { role: 'assistant', content: 'Old claim' } } }
  ]
  const result = assembleContext([{ role: 'system', content: 'rules' }, host()], summary as any, historyGroups(records, 'current'))
  expect(manifest(result).entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ message: 1, kind: 'summary', representation: 'summary-only' }),
    expect.objectContaining({ source: { kind: 'message', id: 'user-9' }, recorded_sequence: 9 }),
    expect.objectContaining({ source: { kind: 'event', id: 'response-10' }, recorded_sequence: 10 })
  ]))
  expect(JSON.stringify(result)).not.toContain('request_evidence')
  expect(manifest(result)).not.toHaveProperty('authority')
  expect(summaryMessage(summary as any).content).toBe('工作摘要：\nOld goal')
})

it('records full historical results without preview substitution', () => {
  const records: any[] = [
    { id: 'response', sequence: 1, kind: 'model.response', payload: { run_id: 'old', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c' }] } } },
    { id: 'result', sequence: 2, kind: 'model.tool_result', payload: { run_id: 'old', message: { role: 'tool', tool_call_id: 'c', content: JSON.stringify({ execution: 'success', delivery: 'delivered', data: 'x'.repeat(10000) }) } } }
  ]
  const result = assembleContext([{ role: 'system', content: 'rules' }, host()], null, historyGroups(records, 'current'))
  expect(manifest(result).entries.find((e: any) => e.source?.id === 'result')).toMatchObject({ representation: 'recorded-message' })
})

it('rebuilds exact-body reuse locations after projection without authenticating omitted text', () => {
  const read = (id: string) => evidenceMessage({ role: 'tool', tool_call_id: id, content: JSON.stringify({ request_type: 'read', execution: 'success', delivery: 'delivered', data: { content_selection: true, metadata: { id: 'r', sha256: 'hash' }, content_version: 'v', actual_range: { start_bytes: 0, end_bytes: 5000 }, data: { text: 'x'.repeat(5000) } } }) }, { kind: 'model.tool_result', representation: 'recorded-message', source: { kind: 'event', id }, recorded_sequence: id === 'one' ? 1 : 2 })
  const first = read('one'), second = read('two'), result = [host(), ...projectContent([first, second])]
  expect(manifest(result).entries.find((e: any) => e.source?.id === 'two')).toMatchObject({ representation: 'exact-body-reuse', reused_from_message: 1 })
  const rebuilt = [host(), ...projectContent([second])]
  expect(manifest(rebuilt).entries.find((e: any) => e.source?.id === 'two')).toMatchObject({ representation: 'recorded-message' })
})

it('does not treat tool-authored reuse fields as a host projection', () => {
  const first = evidenceMessage({ role: 'tool', tool_call_id: 'one', content: '{"data":{"data":{"text":"unrelated"}}}' }, { kind: 'model.tool_result', representation: 'recorded-message' })
  const fake = evidenceMessage({ role: 'tool', tool_call_id: 'two', content: '{"data":{"data":{"context_reuse":{"tool_call_id":"one"}}}}' }, { kind: 'model.tool_result', representation: 'recorded-message' })
  const entries = manifest([host(), first, fake]).entries
  expect(entries[2]).toMatchObject({ message: 2, representation: 'recorded-message' })
  expect(entries[2]).not.toHaveProperty('reused_from_message')
})

it('counts final serialized projection in capacity without changing model settings', () => {
  const messages = [host(), attachEvidence({ role: 'user', content: 'Original' }, { kind: 'message.user', representation: 'recorded-message', source: { kind: 'message', id: 'id' }, recorded_sequence: 1 })]
  const config = { id: 'test', base_url: 'https://example.invalid', wire_model_id: 'test', context_tokens: 100000, compatibility_profile: 'chat-max-tokens' as const }
  expect(new RunBudget(config).estimate(messages, undefined)).toBe(Buffer.byteLength(JSON.stringify({ messages })) + 256)
  expect(config).not.toHaveProperty('max_output_tokens')
})

it('does not join equal tool IDs across Runs, and separates old reads from current host state', () => {
  const response = (run: string, sequence: number, id: string, target: string) => ({ id, sequence, kind: 'model.response', payload: { run_id: run, message: { role: 'assistant', content: null, tool_calls: [{ id: 'same', function: { name: 'read', arguments: JSON.stringify({ kind: 'surface', id: target }) } }] } } })
  const result = (run: string, sequence: number, id: string, target: string, revision: number) => ({ id, sequence, kind: 'model.tool_result', payload: { run_id: run, message: { role: 'tool', tool_call_id: 'same', content: JSON.stringify({ execution: 'success', delivery: 'delivered', data: { metadata: { id: target }, revision } }) } } })
  const modern = response('new', 3, 'c', 'other')
  modern.payload.message.tool_calls[0]!.function.arguments = JSON.stringify({ kind: 'surface', id: 'other' })
  const records = [response('old', 1, 'a', 'surface'), result('old', 2, 'b', 'surface', 2), modern, result('new', 4, 'd', 'other', 7)]
  const input = manifest(assembleContext([{ role: 'system', content: 'rules' }, host()], null, historyGroups(records as any, 'new')))
  expect(input.entries.find((e: any) => e.source?.id === 'b')).toMatchObject({ read_target: { kind: 'surface', id: 'surface' }, observed_revision: 2, recorded_sequence: 2 })
  expect(input.entries.find((e: any) => e.source?.id === 'd')).toMatchObject({ read_target: { kind: 'surface', id: 'other' }, observed_revision: 7, recorded_sequence: 4 })
  expect(JSON.stringify(input)).not.toContain('current_observation')
})

it('refuses incomplete groups instead of silently dropping results', () => {
  const records = [{ id: 'partial', sequence: 2, kind: 'model.response', payload: { run_id: 'old', message: { role: 'assistant', content: null, tool_calls: [{ id: 'missing' }] } } }]
  expect(() => historyGroups(records as any, 'current')).toThrow('CONTEXT_NO_SAFE_GROUP')
})

it('sends the same projected messages that accounting measures, without adding an output limit', async () => {
  const config = { id: 'isolated', base_url: 'https://example.invalid', wire_model_id: 'synthetic', context_tokens: 100000, compatibility_profile: 'chat-max-tokens' as const }
  const service = new ModelService(), events: any[] = []
  service.configure({ type: 'model.configure', configuration: config, api_key: 'synthetic-only', confirm_memory_only: true })
  const lease: ModelLease = { id: config.id, revision: 1, config, release() {}, accounting: event => events.push(event) }
  const send = vi.spyOn(ChatAdapter.prototype, 'complete').mockResolvedValue({ text: 'ok', calls: [], finish: 'stop' })
  try {
    const messages = [host()], expected = structuredClone(messages)
    await service.request(lease, 'task', messages, undefined, new AbortController().signal)
    const actual = send.mock.calls[0]![2]
    expect(actual).toEqual(expected)
    expect(JSON.stringify(actual)).not.toContain('request_evidence')
    expect(actual[0]!.role).toBe(expected[0]!.role)
    expect(events[0].input_bytes).toBe(Buffer.byteLength(JSON.stringify({ messages: actual })))
    expect(events[0].output_reserve).toBeNull(); expect(send.mock.calls[0]![6]).toBeUndefined()
    expect(events.map(e => e.phase)).toEqual(['reserved', 'dispatched', 'completed'])
  } finally { send.mockRestore(); service.close() }
})

it('describes read fragments and historical approval visibility without claiming whole originals or new authority',()=>{
 const part=evidenceMessage({role:'tool',tool_call_id:'part',content:JSON.stringify({execution:'success',delivery:'delivered',data:{metadata:{id:'approval'},representation:'application/json',content_version:'fixed',data:{text:'{"decision":'},truncated:true,next_cursor:'continue'}})},{kind:'model.tool_result',representation:'historical-preview',read_target:{kind:'approval',id:'approval'},source:{kind:'event',id:'record'},recorded_sequence:7})
 const projection=manifest([host(),part]);expect(projection.entries[1]).toMatchObject({read_target:{kind:'approval',id:'approval'},content_version:'fixed',representation:'historical-preview',read_observation:{representation:'application/json',truncated:true,has_continuation:true}});expect(projection.entries[1]).not.toHaveProperty('observed_revision');expect(projection).not.toHaveProperty('authority')
 const text=evidenceMessage({role:'tool',content:JSON.stringify({execution:'success',delivery:'delivered',data:{metadata:{id:'resource'},content_selection:true,content_version:'fixed',actual_range:{start_bytes:8000,end_bytes:9000},data:{text:'fragment'},truncated:false,next_cursor:null}})},{kind:'model.tool_result',representation:'recorded-message',read_target:{kind:'resource',id:'resource'}})
 expect(manifest([host(),text]).entries[1]!.read_observation).toEqual({representation:'selected-plaintext',truncated:false,has_continuation:false,actual_range:{start_bytes:8000,end_bytes:9000}})
})

it('stores only typed identities and ranges for both existing line and byte continuations',()=>{
 for(const actual_range of [{start_line:1,end_line:4},{start_bytes:0,end_bytes:8,chars:2}]){
  const text=attachEvidence({role:'tool',tool_call_id:'part',content:JSON.stringify({request_type:'read',execution:'success',delivery:'delivered',data:{metadata:{id:'resource'},content_version:'fixed',actual_range,data:{text:'DO_NOT_COPY_BODY'},truncated:true,next_cursor:'secret-cursor'}})},{kind:'model.tool_result',representation:'recorded-message',source:{kind:'event',id:'event'},read_target:{kind:'resource',id:'resource'}})
  const event=requestEvidence([host(),text],'request','main')
  assertContract('request_evidence',event)
  expect(event.entries[1]!.read_observation.actual_range).toEqual(actual_range)
  expect(JSON.stringify(event)).not.toContain('DO_NOT_COPY_BODY');expect(JSON.stringify(event)).not.toContain('secret-cursor')
 }
})
it('does not recreate historical request relations or current-chat membership lists', () => {
 const messages = [host(), evidenceMessage({role:'assistant',content:'same saved chat'},{kind:'model.response',representation:'recorded-message',source:{kind:'event',id:'response'},recorded_sequence:4})]
 const before = JSON.stringify(messages)
 expect(requestEvidence(messages,'p1','main').entries).toHaveLength(2)
 expect(JSON.stringify(messages)).toBe(before)
 expect(JSON.stringify(messages)).not.toMatch(/request_relations|request_evidence|execution_identity/)
})
