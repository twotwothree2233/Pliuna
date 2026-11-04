import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeStore } from '../../src/runtime/store'
import { modelToolRequest, modelToolResult } from '../../src/runtime/model/tool-input'
import { assertContract } from '../../src/shared/validation'
import { attachEvidence, requestEvidence } from '../../src/runtime/model/request-evidence'
import { montyContract } from '../../src/runtime/monty/contract'
import { contractRepresentation } from '../../src/runtime/model/operation-contracts'
let store: RuntimeStore, task: string, other: string, run: string
beforeEach(() => { vi.useFakeTimers(); store = new RuntimeStore(mkdtempSync(join(tmpdir(), 'trellis-interface-query-'))); task = store.create('Interface regression').task.id; other = store.create('Other').task.id; run = store.start(task, 'synthetic', 'fixture', []) })
afterEach(() => { store.close(); vi.useRealTimers() })
async function read(raw: any, owner = task, source = run): Promise<any> {
  return modelToolResult('read', raw, await store.agentTool(owner, source, modelToolRequest('read', raw), new AbortController().signal))
}
function insert(id: string, text: string) { (store as any).db.prepare('INSERT INTO task_data (id,task_id,revision,schema_json,value_json,references_json) VALUES (?,?,1,?,?,?)').run(id, task, '{"type":"string"}', JSON.stringify(text), '[]') }

it('continues actual object pages, keeps structured small objects, validates evidence without changing its format', async () => {
  insert('long', '中😀'.repeat(7000))
  const raw = { kind: 'task_data', id: 'long', max_chars: 311, selection: { revision: 1 } }, first = await read(raw)
  let page = first, text = ''
  do {
    text += page.data.data.text
    const message = attachEvidence({ role: 'tool' as const, tool_call_id: 'read', content: JSON.stringify(page) }, { kind: 'model.tool_result', representation: 'recorded-message', source: { kind: 'event', id: 'result' }, read_target: { kind: 'task_data', id: 'long' } })
    assertContract('request_evidence', requestEvidence([message], 'request', 'main'))
    if (!page.data.next_call) break
    page = await read(page.data.next_call.arguments)
  } while (true)
  expect(JSON.parse(text).value).toBe('中😀'.repeat(7000))
  const small = await read({ kind: 'task', id: task })
  expect(small.data.data.title).toBe('Interface regression')
  expect(small.data.representation).toBeUndefined()
  for (const changed of [{ ...raw, max_chars: 312 }, { ...raw, selection: { revision: 1, view: 'object', lines: [1, 2] } }]) await expect(read({ ...changed, cursor: first.data.next_cursor })).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
  const otherRun = store.start(other, 'synthetic', 'fixture', [])
  await expect(read(first.data.next_call.arguments, other, otherRun)).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
  ;(store as any).db.prepare('UPDATE task_data SET revision=2 WHERE id=?').run('long')
  await expect(read(first.data.next_call.arguments)).rejects.toMatchObject({ code: 'READ_VERSION_CHANGED' })
})

it('continues selected text using exactly returned arguments and rejects representation and page-size changes', async () => {
  const result: any = await store.agentTool(task, run, modelToolRequest('write', { operation: 'resource.create', input_json: JSON.stringify({ display_name: 'text', content: { type: 'text', text: '中😀'.repeat(9000) } }) }), new AbortController().signal)
  const raw = { kind: 'resource', id: result.data.id, selection: { view: 'text' }, max_chars: 32000 }
  const first = await read({ ...raw, max_chars: 100 })
  expect([...first.data.data.text]).toHaveLength(100)
  expect((await read(first.data.next_call.arguments)).data.actual_range.start_bytes).toBe(first.data.actual_range.end_bytes)
  await expect(read({ ...first.data.next_call.arguments, max_chars: 101 })).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
  await expect(read({ ...first.data.next_call.arguments, selection: { view: 'object' } })).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
  const full = await read(raw)
  expect(full.data.actual_range.chars).toBe(18000)
  expect(full.data.next_cursor).toBeNull()
  const object = await read({ kind: 'resource', id: result.data.id, max_chars: 20, selection: { view: 'object' } })
  expect(object.data.content_selection).toBeUndefined()
  expect(object.data.data.text).not.toBe('中😀'.repeat(10))
})

it('rejects JSON encoding and invalid references without registering Call or Action', async () => {
  const before = (store as any).db.prepare('SELECT count(*) n FROM actions').get()
  for (const input_json of ['{', 'null', '"{\\"value\\":1}"', '{"type":"task_data.remove","id":"x","expected_revision":1}']) {
    expect(() => modelToolRequest('write', { operation: 'task_data.remove', input_json })).toThrow()
  }
  await expect(store.agentTool(task, run, modelToolRequest('write', { operation: 'task_data.create', input_json: JSON.stringify({ data: { schema: { type: 'string' }, value: 'ok', references: [{ name: 'missing', target: { kind: 'resource', id: 'absent' } }] } }) }), new AbortController().signal)).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' })
  expect((store as any).db.prepare('SELECT count(*) n FROM actions').get()).toEqual(before)
  expect((store as any).db.prepare('SELECT count(*) n FROM calls').get()).toEqual({ n: 0 })
})

it('keeps capability outputs and quotas discoverable and uses new call encoding in examples', () => {
  const guide: any = contractRepresentation(montyContract, { view: 'guide' })
  expect(JSON.parse(guide.example.input_json)).toEqual(montyContract.example)
  expect(guide.example.capability).toBe(montyContract.id)
  expect(guide.sections.map((s: any) => s.id)).toEqual(expect.arrayContaining(['output', 'limits', 'approval', 'lifecycle']))
  expect(contractRepresentation(montyContract, { view: 'schema', section: 'limits' })).toEqual(montyContract.limits)
})

it('defaults text only on explicit read, supports search and metadata, expires cursors on restart', async () => {
 const created:any=await store.agentTool(task,run,modelToolRequest('write',{operation:'resource.create',input_json:JSON.stringify({display_name:'body',content:{type:'text',text:'first\r\n中😀 needle\nneedle\nlast'}})}),new AbortController().signal)
 const id=created.data.id, first=await read({kind:'resource',id,max_chars:3})
 expect(first.data.data.text).toBe('fir');expect(first.data.content_selection).toBe(true)
 expect(first.data.next_call.arguments).toEqual({kind:'resource',id,cursor:first.data.next_cursor})
 expect(first.data.next_cursor.length).toBeLessThanOrEqual(200)
 const line=await read({kind:'resource',id,selection:{lines:[2,2]},max_chars:32000})
 expect(line.data.data.text).toBe('中😀 needle\n');expect(line.data.completion).toEqual({selection_complete:true,search_complete:null,full_body_delivered:false})
 const hit=await read({kind:'resource',id,selection:{find:'needle'},max_chars:32000})
 expect(hit.data.data.matches[0].text).toBe('中😀 needle\n');expect(hit.data.completion.full_body_delivered).toBe(false)
 expect(hit.data.data.matches[1].text).toBe('needle\n');expect(hit.data.next_cursor).toBeNull()
 const metadata=await read({kind:'resource',id,selection:{view:'metadata'}})
 expect(metadata.data.data.id).toBe(id);expect(metadata.data.data).not.toHaveProperty('text');expect(metadata.data.data).not.toHaveProperty('storage_key')
 await expect(read({kind:'resource',id,selection:{pages:[1,1]}})).rejects.toMatchObject({code:'RESOURCE_RANGE_INVALID'})
 ;(store as any).db.prepare('DELETE FROM task_resources WHERE resource_id=?').run(id)
 await expect(read(first.data.next_call.arguments)).rejects.toMatchObject({code:'NOT_FOUND'})
})
