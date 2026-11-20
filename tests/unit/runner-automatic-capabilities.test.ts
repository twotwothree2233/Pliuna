import { mkdtempSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatAdapter, type ChatMessage, type Completion } from '../../src/runtime/model/adapter'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import * as montyAssets from '../../src/runtime/monty/assets'
import { MONTY_ID } from '../../src/runtime/monty/contract'
import * as montyRunner from '../../src/runtime/monty/runner'
import { pluginCapabilityId } from '../../src/runtime/plugins/directory'
import type { PluginProcesses } from '../../src/runtime/plugins/process'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'
import { RuntimeStore } from '../../src/runtime/store'
import type { ModelConfiguration } from '../../src/shared/contracts.generated'
import { ContractError } from '../../src/shared/validation'

type CallRow = { id: string; task_id: string; run_id: string; capability_id: string; instance_id: string | null; state: string; dispatch: string; execution: string | null; delivery: string; commit_valid: number; limits_json: string; ended_at: string | null }
type ToolResult = { execution: string; data?: { items?: { id: string }[]; data?: unknown; value?: unknown }; error?: { code: string } }
const fixtures: { root: string; store: RuntimeStore; internal: { pluginProcesses: PluginProcesses } }[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.internal.pluginProcesses.shutdown('test_cleanup', 20)
    await fixture.store.shutdown()
    await rm(fixture.root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

const answer = (text: string): Completion => ({ text, calls: [], finish: 'stop', usage: { prompt_tokens: 30, completion_tokens: 8 } })
function tool(id: string, name: string, input: unknown): Completion {
  return { text: '', calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }], finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 8 } }
}
const invoke = (id: string, capability: string, value: unknown) => tool(id, 'call', { capability, input_json: JSON.stringify({ value }), references: [] })
const read = (id: string, capability: string) => tool(id, 'read', { kind: 'capability', id: capability, selection: { view: 'schema' } })
function result(messages: ChatMessage[], id: string): ToolResult {
  const message = messages.find(message => message.role === 'tool' && message.tool_call_id === id)
  expect(message, `missing tool result ${id}`).toBeDefined()
  return JSON.parse(message!.content!) as ToolResult
}
function setup(monty = false) {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-automatic-capabilities-'))
  const adapter = new ChatAdapter(), models = new ModelService(adapter)
  const config: ModelConfiguration = { id: 'production', base_url: 'https://example.invalid/v1', wire_model_id: 'synthetic', context_tokens: 100000, max_output_tokens: 4096, compatibility_profile: 'chat-max-tokens' }
  models.configure({ type: 'model.configure', configuration: config, api_key: 'synthetic', confirm_memory_only: true })
  vi.spyOn(models, 'acquire').mockImplementation((): ModelLease => ({ id: config.id, revision: 1, config, release: vi.fn() }))
  vi.spyOn(models, 'acquireCompaction').mockReturnValue(undefined)
  const complete = vi.spyOn(adapter, 'complete')
  const store = new RuntimeStore(root, models, { viewReplacement: true, monty, runner: { productionRuns: 2 } }, undefined, process.execPath)
  const internal = store as unknown as { db: Database.Database; pluginProcesses: PluginProcesses }
  const db = internal.db, state = new RunnerWorkState(db, store.epoch), task = store.create('Automatic capability grants').task.id
  const calls = () => db.prepare('SELECT * FROM calls ORDER BY rowid').all() as CallRow[]
  const records = (kind: string) => (db.prepare('SELECT payload_json FROM records WHERE task_id=? AND kind=? ORDER BY sequence').all(task, kind) as { payload_json: string }[]).map(row => JSON.parse(row.payload_json))
  const owner = (run: string) => {
    const work = state.taskWorks(task).find(work => work.run_id === run)!
    if (work.purpose !== 'production') throw Error('Expected production work')
    return { task_id: task, run_id: run, work_id: work.work_id, attempt_id: work.current_attempt_id, role: work.role, purpose: work.purpose, request_id: work.request_id, intent_revision: work.intent_revision }
  }
  const fixture = { root, store, internal, db, state, task, complete, calls, records, owner }
  fixtures.push(fixture)
  return fixture
}

const backend = `
const rl = require('node:readline').createInterface({input: process.stdin});
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', line => {
  const m = JSON.parse(line);
  if (!m.id) return;
  if (m.method === 'initialize') send({jsonrpc:'2.0',id:m.id,result:{protocol_version:'0.1',plugin_id:m.params.plugin_id,capabilities:m.params.capabilities}});
  else if (m.method === 'tools.execute') {
    if (!m.params.arguments.value?.wait) send({jsonrpc:'2.0',id:m.id,result:{value:m.params.arguments.value}});
  }
  else if (m.method === 'shutdown') send({jsonrpc:'2.0',id:m.id,result:{}});
});`
async function plugin(s: ReturnType<typeof setup>, name: string, task = s.task) {
  const source = join(s.root, name)
  await mkdir(source)
  await writeFile(join(source, 'backend.cjs'), backend)
  await writeFile(join(source, 'tool.json'), JSON.stringify({ id: 'echo', description: name, when_to_use: 'tests', input_schema: { type: 'object', required: ['value'] }, output_schema: { type: 'object', required: ['value'] }, effect: 'read', timeout_ms: 5000, errors: [], examples: [] }))
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ manifest_version: '0.1', protocol_version: '0.1', id: name, version: '1.0.0', access_level: 'task', contributes: [{ id: 'echo', kind: 'tool', entry: 'tool.json', description: name }], backend: { runtime: 'app-node', entry: 'backend.cjs' } }))
  const installed = await s.store.handle({ type: 'plugin.internal.install', source }) as { digest: string }
  await s.store.handle({ type: 'plugin.trust', digest: installed.digest, confirm_local_code: true, confirm_cross_task: false })
  const plan = await s.store.handle({ type: 'plugin.plan', task_id: task, digest: installed.digest }) as { fingerprint: string }
  await s.store.handle({ type: 'plugin.enable', task_id: task, digest: installed.digest, fingerprint: plan.fingerprint, confirm_cross_task: false })
  return { digest: installed.digest, capability: pluginCapabilityId(installed.digest, 'echo') }
}

it('discovers, reads and calls only this Task enabled capabilities through automatic production', async () => {
  const s = setup(), local = await plugin(s, 'fixture.local')
  const otherTask = s.store.create('Another Task').task.id, other = await plugin(s, 'fixture.other', otherTask)
  let discovered = ''
  s.complete.mockResolvedValueOnce(tool('discover', 'list', { kind: 'capability' }))
    .mockImplementationOnce(async (_config, _key, messages, tools) => {
      expect(tools?.map(tool => tool.function.name)).toContain('call')
      expect(result(messages, 'discover')).toMatchObject({ execution: 'success', data: { items: [{ id: local.capability }] } })
      expect(result(messages, 'discover').data!.items).toHaveLength(1)
      discovered = result(messages, 'discover').data!.items![0]!.id
      return read('contract', discovered)
    })
    .mockImplementationOnce(async (_config, _key, messages) => {
      expect(result(messages, 'contract')).toMatchObject({ execution: 'success', data: { data: { type: 'object', required: ['value'] } } })
      return invoke('local-call', discovered, 'local result')
    })
    .mockImplementationOnce(async (_config, _key, messages) => {
      expect(result(messages, 'local-call')).toMatchObject({ execution: 'success', data: { value: 'local result' } })
      return read('other-read', other.capability)
    })
    .mockImplementationOnce(async (_config, _key, messages) => {
      expect(result(messages, 'other-read')).toMatchObject({ execution: 'not_executed', error: { code: 'WORKER_CAPABILITY_DENIED' } })
      return invoke('other-call', other.capability, 'must not execute')
    })
    .mockImplementationOnce(async (_config, _key, messages) => {
      expect(result(messages, 'other-call')).toMatchObject({ execution: 'not_executed', error: { code: 'WORKER_CAPABILITY_DENIED' } })
      return answer('Exact enabled capability completed')
    })
  const run = s.store.start(s.task, 'Use the enabled local tool', 'production', [])
  await vi.waitFor(() => expect(s.state.run(run).state).toBe('completed'))
  expect(s.calls()).toHaveLength(1)
  expect(s.calls()[0]).toMatchObject({ task_id: s.task, run_id: run, capability_id: local.capability, execution: 'success', delivery: 'delivered' })
  expect(JSON.parse(s.calls()[0]!.limits_json).owner).toMatchObject(s.owner(run))
  expect(s.records('worker.tool.started').find(record => record.request_type === 'call')).toMatchObject({ owner: s.owner(run), run_id: run, capability: local.capability })
  expect(s.records('runner.answer')).toMatchObject([{ owner: s.owner(run), text: 'Exact enabled capability completed' }])
})

it('settles an in-flight automatic plugin call when the host shuts down', async () => {
  const s = setup(), local = await plugin(s, 'fixture.shutdown')
  s.complete.mockResolvedValueOnce(invoke('waiting-call', local.capability, { wait: true }))
  const run = s.store.start(s.task, 'Wait in the enabled tool', 'production', [])
  await vi.waitFor(() => expect(s.calls()).toMatchObject([{ run_id: run, capability_id: local.capability, dispatch: 'sent', execution: null, instance_id: expect.any(String) }]))
  const sent = s.calls()[0]!, owner = s.owner(run), databasePath = s.db.name
  expect(JSON.parse(sent.limits_json).owner).toEqual(owner)
  expect(s.complete).toHaveBeenCalledTimes(1)

  await s.store.shutdown()
  const persisted = new Database(databasePath, { readonly: true })
  try {
    expect(persisted.prepare('SELECT state,intended_terminal,primary_reason,commit_valid FROM runs WHERE task_id=? AND id=?').get(s.task, run)).toEqual({ state: 'interrupted', intended_terminal: 'interrupted', primary_reason: 'host_shutdown', commit_valid: 0 })
    const settled = persisted.prepare('SELECT * FROM calls WHERE id=?').get(sent.id) as CallRow
    expect(settled).toMatchObject({ task_id: s.task, run_id: run, instance_id: sent.instance_id, state: 'ended', dispatch: 'sent', execution: 'cancelled', delivery: 'delivered', commit_valid: 0 })
    expect(settled.ended_at).not.toBeNull()
    expect(JSON.parse(settled.limits_json).owner).toEqual(owner)
    const cleanup = persisted.prepare("SELECT necessary,state,detail_json FROM cleanup_jobs WHERE task_id=? AND owner_kind='plugin_instance' AND owner_id=?").get(s.task, sent.instance_id) as { necessary: number; state: string; detail_json: string }
    expect(cleanup).toMatchObject({ necessary: 1, state: 'done' })
    const cleanupFact = { instance_id: sent.instance_id, instance_key: `${local.digest}:${s.task}`, call_ids: [sent.id], reason: 'PLUGIN_PROCESS_EXITED' }
    expect(JSON.parse(cleanup.detail_json)).toEqual(cleanupFact)
    const records = (kind: string) => (persisted.prepare('SELECT payload_json FROM records WHERE task_id=? AND kind=? ORDER BY sequence').all(s.task, kind) as { payload_json: string }[]).map(row => JSON.parse(row.payload_json))
    expect(records('plugin.call.ended')).toMatchObject([{ call_id: sent.id, package_digest: local.digest, execution: 'cancelled', owner }])
    expect(records('plugin.instance.cleanup_confirmed')).toMatchObject([{ kind: 'cleanup_confirmed', ...cleanupFact }])
    expect(s.complete).toHaveBeenCalledTimes(1)
  } finally {
    persisted.close()
  }
})

it.each(['disable', 'revoke'] as const)('rechecks plugin %s after automatic profile creation before read or call dispatch', async operation => {
  const s = setup(), local = await plugin(s, 'fixture.revoked')
  s.complete.mockImplementationOnce(async () => {
    if (operation === 'disable') await s.store.handle({ type: 'plugin.disable', task_id: s.task, digest: local.digest })
    else await s.store.handle({ type: 'plugin.revoke', digest: local.digest })
    return read('revoked-read', local.capability)
  }).mockImplementationOnce(async (_config, _key, messages) => {
    expect(result(messages, 'revoked-read')).toMatchObject({ execution: 'not_executed', error: { code: 'PLUGIN_CAPABILITY_UNAVAILABLE' } })
    return invoke('revoked-call', local.capability, 'must not execute')
  }).mockImplementationOnce(async (_config, _key, messages) => {
    expect(result(messages, 'revoked-call')).toMatchObject({ execution: 'not_executed', error: { code: 'PLUGIN_CAPABILITY_UNAVAILABLE' } })
    return answer('Revoked capability was not executed')
  })
  const run = s.store.start(s.task, 'Recheck current plugin availability', 'production', [])
  await vi.waitFor(() => expect(s.state.run(run).state).toBe('completed'))
  expect(s.calls()).toEqual([])
  const listed = await s.store.handle({ type: 'plugin.list', task_id: s.task }) as { items: { instances: unknown[] }[] }
  expect(listed.items.flatMap(item => item.instances)).toEqual([])
})

it.each(['disabled', 'missing', 'available'] as const)('grants automatic Monty discovery, contract reads and calls when %s', async availability => {
  const available = availability === 'available'
  const assets = vi.spyOn(montyAssets, 'montyAssets').mockImplementation(() => {
    if (!available) throw new ContractError('MONTY_RUNTIME_UNAVAILABLE', 'Synthetic missing runtime')
    return { binary: 'fixture-binary', native: 'fixture-native', binary_sha256: '0'.repeat(64), runner: 'fixture-runner' }
  })
  const native = vi.spyOn(montyRunner, 'nativeMonty').mockImplementation((_assets, _input, _signal, _runtime, started) => {
    started(123)
    return { result: Promise.resolve({ ok: true, value: { type: 'json', value: { answer: 17 } }, stdout: '', stderr: '' }), stop: async () => {} }
  })
  const s = setup(availability !== 'disabled')
  s.complete.mockResolvedValueOnce(tool('discover', 'list', { kind: 'capability' }))
    .mockImplementationOnce(async (_config, _key, messages) => {
      expect(result(messages, 'discover').data!.items?.map(item => item.id)).toEqual(available ? [MONTY_ID] : [])
      return read('monty-contract', MONTY_ID)
    })
    .mockImplementationOnce(async (_config, _key, messages) => {
      expect(result(messages, 'monty-contract')).toMatchObject(available ? { execution: 'success', data: { data: { required: ['code', 'inputs'], properties: { code: { type: 'string' }, inputs: { type: 'object' } } } } } : { execution: 'not_executed', error: { code: 'WORKER_CAPABILITY_DENIED' } })
      return tool('monty-call', 'call', { capability: MONTY_ID, input_json: JSON.stringify({ code: 'result = 17', inputs: {} }), references: [] })
    })
    .mockImplementationOnce(async (_config, _key, messages) => {
      expect(result(messages, 'monty-call')).toMatchObject(available ? { execution: 'success', data: { version: 1, value: { type: 'json', value: { answer: 17 } } } } : { execution: 'not_executed', error: { code: 'WORKER_CAPABILITY_DENIED' } })
      return answer('Monty availability respected')
    })
  const run = s.store.start(s.task, 'Use available computation', 'production', [])
  await vi.waitFor(() => expect(s.state.run(run).state).toBe('completed'))
  expect(assets).toHaveBeenCalledTimes(availability === 'disabled' ? 0 : 1)
  expect(native).toHaveBeenCalledTimes(available ? 1 : 0)
  expect(s.calls()).toHaveLength(available ? 1 : 0)
  if (available) expect(JSON.parse(s.calls()[0]!.limits_json).owner).toMatchObject(s.owner(run))
})
