import { afterEach, describe, expect, it } from 'vitest'
import { ChatAdapter, endpoint } from '../../src/runtime/model/adapter'
import { ModelService, ModelScheduler } from '../../src/runtime/model/service'
import { frame, modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
import { modelToolRequest } from '../../src/runtime/model/tool-input'
import { operationContract } from '../../src/runtime/model/operation-contracts'
import { modelTools } from '../../src/runtime/model/tools'
import Ajv2020 from 'ajv/dist/2020.js'
import { modelErrorMessage } from '../../src/renderer/src/model-errors'
import type { ModelConfiguration } from '../../src/shared/contracts.generated'
import defaults from '../../src/shared/contracts/development-defaults.json'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
const config = (url: string): ModelConfiguration => ({ id: 'configured', base_url: url, wire_model_id: 'exact-model-id', context_tokens: 100000, max_output_tokens: 1024, compatibility_profile: 'chat-max-tokens' })
const tool = [{ type: 'function' as const, function: { name: 'list', description: 'list', parameters: { type: 'object' } } }]
describe('Chat Completions wire adapter via real HTTP', () => {
  it('reports safe outer JSON coordinates without dispatching or exposing input', async () => {
    const payload = '{\n"private":"PRIVATE_SENTINEL",\n"x": }'
    const adapter = new ChatAdapter(async () => new Response(frame({ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'write', arguments: payload } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    try { await adapter.complete(config('https://example.invalid'), '', [], tool, new AbortController().signal); throw Error('must reject') } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_TOOL_ARGUMENTS', partial: true, retryable: false, inputDiagnostic: expect.stringContaining('tool arguments: invalid JSON at offset ' + payload.indexOf('}')) })
      expect((error as Error).message).toContain('line 3, column 6')
      expect((error as Error).message).not.toContain('PRIVATE_SENTINEL')
    }
  })
  it('keeps outer JSON failure coordinates in the existing bounded request error field', async () => {
    const payload = '{"private":"PRIVATE_SENTINEL","x":}'
    const server = await modelServer(({ body }, res) => {
      if (synthetic(body, res)) return
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(frame({ tool_calls: [{ index: 0, id: 'invalid-outer', type: 'function', function: { name: 'write', arguments: payload } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n')
    }); cleanups.push(server.close)
    const service = new ModelService(); cleanups.push(() => Promise.resolve(service.close()))
    service.configure({ type: 'model.configure', configuration: config(server.url), api_key: '', confirm_memory_only: true })
    await service.test('configured', 'main')
    const lease = service.acquire('configured', 'main'), events: any[] = []
    lease.accounting = event => events.push(event)
    try {
      await expect(service.request(lease, 'task', [{ role: 'user', content: 'business' }], tool, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_TOOL_ARGUMENTS' })
      expect(events.at(-1).error).toBe(`INVALID_TOOL_ARGUMENTS; outer JSON UTF16 offset=${payload.indexOf('}')} line=1 column=${payload.indexOf('}') + 1}`)
      expect(events.at(-1).error.length).toBeLessThanOrEqual(100)
      expect(JSON.stringify(events)).not.toContain('PRIVATE_SENTINEL')
    } finally { lease.release() }
  })
  it('keeps explicit object tool roots and all local parameter constraints', () => {
    const ajv = new Ajv2020({ strict: false })
    for (const tool of modelTools) {
      expect(tool.function.parameters).toHaveProperty('type', 'object')
      const validate = ajv.compile(tool.function.parameters as object)
      expect(validate(null)).toBe(false)
      expect(validate({ unexpected: true })).toBe(false)
    }
    const list = ajv.compile(modelTools[0]!.function.parameters as object)
    expect(list({ kind: 'capability' })).toBe(true)
    expect(list({ kind: 'credential' })).toBe(false)
    expect(() => modelToolRequest('list', { kind: 'credential' })).toThrow()
    const write = modelTools.find(tool => tool.function.name === 'write')!
    expect(JSON.parse(JSON.parse(write.function.description.split('示例：')[1]!).input_json).content).toEqual({ type: 'text', text: '正文' })
    expect(JSON.stringify(write.function.parameters)).not.toMatch(/oneOf|\$defs/)
  })
  it('declares explicit JSON text with one decoded capability value', () => {
    const wire: any = modelTools.find(tool => tool.function.name === 'call')!.function.parameters
    expect(wire.properties.input_json).toEqual({ type: 'string' })
    expect(wire).not.toHaveProperty('$defs')
    const validate = new Ajv2020({ strict: false }).compile(wire)
    for (const argumentsValue of [{ text: 'echo' }, ['text'], 1, true, null, 'text']) expect(validate({ capability: 'exact-id', input_json: JSON.stringify(argumentsValue), references: [] })).toBe(true)
  })
  it('sends minimal actual HTTP tools while retaining exact host JSON value validation on demand', async () => {
    const server = await modelServer((_exchange, res) => textStream(res, 'ok')); cleanups.push(server.close)
    await new ChatAdapter().complete(config(server.url), '', [], modelTools, new AbortController().signal)
    const wire = server.exchanges[0]!.body.tools.find((tool: any) => tool.function.name === 'write').function.parameters
    expect(wire.required).toEqual(['operation', 'input_json'])
    expect(wire).not.toHaveProperty('oneOf'); expect(wire).not.toHaveProperty('$defs')
    const contract = operationContract('task_data.replace') as any
    const validate = new Ajv2020({ strict: false }).compile(contract.input_schema)
    for (const candidate of [{ stage: 'updated', nested: [null, { enabled: true }, 1] }, [], 'literal', 1, false, null]) {
      const input = { id: 'object-id', expected_revision: 1, value: candidate, references: [] }
      expect(validate(input)).toBe(true)
      expect(modelToolRequest('write', { operation: 'task_data.replace', input_json: JSON.stringify(input) }).input).toEqual({ type: 'task_data.replace', ...input })
    }
  })
  for (const value of [{ stage: 'updated', nested: [null, false, 3, { text: 'quoted "value"' }] }, ['updated'], '{"stage":"updated"}', 7, true, null]) it('preserves the exact JSON value type from fragmented SSE: ' + JSON.stringify(value), async () => {
    const args = { operation: 'task_data.replace', input_json: JSON.stringify({ id: 'data-id', expected_revision: 1, value, references: [] }) }
    const server = await modelServer((_exchange, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const encoded = JSON.stringify(args)
      res.write(frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'replace-value', type: 'function', function: { name: 'write', arguments: '' } }] }))
      for (const character of encoded) res.write(frame({ tool_calls: [{ index: 0, function: { arguments: character } }] }))
      res.end(frame({}, 'tool_calls') + 'data: [DONE]\n\n')
    }); cleanups.push(server.close)
    const response = await new ChatAdapter().complete(config(server.url), '', [], modelTools, new AbortController().signal)
    expect(response.calls[0]!.function.arguments).toBe(JSON.stringify(args))
    expect(JSON.parse(JSON.parse(response.calls[0]!.function.arguments).input_json).value).toEqual(value)
  })
  it('explains classified errors without suggesting insecure TLS or automatic retries', () => {
    expect(modelErrorMessage(new Error('MODEL_AUTHENTICATION: Runtime operation failed'))).toContain('检查 API Key')
    expect(modelErrorMessage(new Error('MODEL_NETWORK_ERROR: failure'))).toContain('不要关闭 TLS')
    expect(modelErrorMessage(new Error('MODEL_CANCELLED'))).toContain('未启用')
  })
  it('assembles UTF-8 and fragmented indexed tool calls only after terminal response', async () => {
    const server = await modelServer((_x, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const data = frame({ role: 'assistant', content: '你好', tool_calls: [{ index: 0, id: 'c0', type: 'function', function: { name: 'li', arguments: '{"kind":' } }] }) + frame({ tool_calls: [{ index: 0, function: { name: 'st', arguments: '"view"}' } }] }) + frame({}, 'tool_calls') + 'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4}}\n\n' + 'data: [DONE]\n\n'
      const bytes = Buffer.from(data); for (const byte of bytes) res.write(Buffer.from([byte])); res.end()
    }); cleanups.push(server.close)
    const result = await new ChatAdapter().complete(config(server.url), 'secret-sentinel', [{ role: 'user', content: 'hello' }], tool, new AbortController().signal)
    expect(result).toMatchObject({ text: '你好', calls: [{ id: 'c0', function: { name: 'list', arguments: '{"kind":"view"}' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } })
    expect(server.exchanges[0]!.body).toMatchObject({ model: 'exact-model-id', max_tokens: 1024, stream: true, stream_options: { include_usage: true } })
    expect(server.exchanges[0]!.authorization).toBe('Bearer secret-sentinel')
  })
  for (const [name, payload] of [
    ['missing DONE', frame({ content: 'partial' }) + frame({}, 'stop')],
    ['truncated arguments', frame({ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'list', arguments: '{' } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n'],
    ['length finish', frame({ content: 'partial' }) + frame({}, 'length') + 'data: [DONE]\n\n'],
    ['duplicate IDs', frame({ tool_calls: [0, 1].map(index => ({ index, id: 'same', type: 'function', function: { name: 'list', arguments: '{}' } })) }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n'],
    ['invalid JSON', 'data: nope\n\n'],
    ['no terminal reason', frame({ content: 'x' }) + 'data: [DONE]\n\n']
  ]) it('rejects ' + name + ' without emitting executable calls', async () => {
    const server = await modelServer((_x, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(payload) }); cleanups.push(server.close)
    await expect(new ChatAdapter().complete(config(server.url), '', [], tool, new AbortController().signal)).rejects.toBeDefined()
  })
  it('maps authentication errors without returning sensitive provider bodies', async () => {
    const server = await modelServer((_x, res) => { res.writeHead(401); res.end('secret-sentinel provider debug') }); cleanups.push(server.close)
    await expect(new ChatAdapter().complete(config(server.url), '', [], undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_AUTHENTICATION', retryable: false, message: 'MODEL_AUTHENTICATION' })
  })
  it('refuses credential redirects and unsafe service URLs', async () => {
    const target = await modelServer((_x, res) => textStream(res, 'not reached')); cleanups.push(target.close)
    const source = await modelServer((_x, res) => { res.writeHead(307, { location: target.url + '/chat/completions' }); res.end() }); cleanups.push(source.close)
    await expect(new ChatAdapter().complete(config(source.url), 'secret', [], undefined, new AbortController().signal)).rejects.toBeDefined()
    expect(target.exchanges).toHaveLength(0)
    for (const url of ['not-a-url', 'http://remote.example/v1', 'https://user:password@example.test', 'https://example.test/v1?key=secret']) expect(() => endpoint(url, 'models')).toThrow()
  })
  it('aborts a real in-flight stream without a completed response', async () => {
    const server = await modelServer((_x, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(frame({ content: 'partial' })) }); cleanups.push(server.close)
    const controller = new AbortController()
    const result = new ChatAdapter().complete(config(server.url), '', [], undefined, controller.signal, () => controller.abort())
    await expect(result).rejects.toMatchObject({ code: 'MODEL_CANCELLED', partial: true })
  })
  it('does not enable a configuration before explicit role tests', async () => {
    const server = await modelServer(({ body }, res) => { synthetic(body, res) }); cleanups.push(server.close)
    const service = new ModelService(); service.configure({ type: 'model.configure', configuration: config(server.url), api_key: 'secret-sentinel', confirm_memory_only: true })
    expect(() => service.acquire('configured', 'main')).toThrow('explicit synthetic test')
    await service.test('configured', 'main'); const lease = service.acquire('configured', 'main')
    expect(() => service.remove('configured')).toThrow('occupied')
    expect(JSON.stringify(service.list())).not.toContain('secret-sentinel')
    expect(() => service.acquire('configured', 'approval')).toThrow()
    lease.release(); service.remove('configured'); service.close()
  })
  it('keeps max_completion_tokens mapping explicit and does not guess from model name', async () => {
    const server = await modelServer((_x, res) => textStream(res, 'ok')); cleanups.push(server.close)
    await new ChatAdapter().complete({ ...config(server.url), compatibility_profile: 'chat-max-completion-tokens' }, '', [], undefined, new AbortController().signal)
    expect(server.exchanges[0]!.body.max_completion_tokens).toBe(1024)
    expect(server.exchanges[0]!.body.max_tokens).toBeUndefined()
  })
})
describe('real API connection onboarding and cancellable role tests', () => {
  it('cancels a queued discovery without sending, and refuses duplicate active operation IDs', async () => {
    const server = await modelServer((_x, res) => { res.end('{"data":[]}') }); cleanups.push(server.close)
    const scheduler = new ModelScheduler(), service = new ModelService(new ChatAdapter(), scheduler), releases: (() => void)[] = []
    const blockers = Array.from({ length: defaults.queues.model_active_channel }, () => scheduler.schedule('blocker', new URL(server.url).origin, new AbortController().signal, () => new Promise<void>(r => releases.push(r))))
    try {
      await new Promise(r => setTimeout(r, 0))
      const input = { type: 'model.probe', operation_id: 'queued-probe', base_url: server.url, api_key: 'secret', confirm_memory_only: true }
      const queued = service.probe(input)
      await expect(service.probe(input)).rejects.toThrow('still in use')
      service.cancel('queued-probe')
      await expect(queued).rejects.toMatchObject({ code: 'MODEL_CANCELLED' })
      expect(server.exchanges).toHaveLength(0)
    } finally { service.close(); for (const release of releases) release(); await Promise.all(blockers) }
  })
  it('discovers before any model or capacity exists, deduplicates IDs and enables nothing', async () => {
    const server = await modelServer((_x, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"wire"},{"id":"wire"}]}') }); cleanups.push(server.close)
    const service = new ModelService()
    try {
      expect(await service.probe({ type: 'model.probe', operation_id: 'discovery', base_url: server.url, api_key: 'probe-secret', confirm_memory_only: true })).toEqual(['wire'])
      expect(service.list()).toEqual([])
      expect(server.exchanges).toHaveLength(1)
      expect(server.exchanges[0]).toMatchObject({ body: null, url: '/v1/models', authorization: 'Bearer probe-secret' })
      await expect(service.probe({ type: 'model.probe', operation_id: 'bad', base_url: server.url, api_key: 'secret', confirm_memory_only: false })).rejects.toThrow()
      expect(server.exchanges).toHaveLength(1)
    } finally { service.close() }
  })
  it('accepts a tool-only first message and validates terminal text in the second round', async () => {
    const server = await modelServer(({ body }, res) => {
      if (body.messages.at(-1).role === 'tool') { expect(body.messages.at(-2).content).toBeNull(); textStream(res, 'TRELLIS_OK') }
      else hostToolStream(res, 'list', { kind: 'capability' })
    }); cleanups.push(server.close)
    const service = new ModelService()
    try {
      service.configure({ type: 'model.configure', configuration: config(server.url), api_key: '', confirm_memory_only: true })
      await expect(service.test('configured', 'main')).resolves.toMatchObject({ enabled: true })
      expect(server.exchanges).toHaveLength(2)
      expect(server.exchanges.every(e => e.body.max_tokens === config(server.url).max_output_tokens)).toBe(true)
    } finally { service.close() }
  })
  for (const failure of ['text-command', 'wrong-target', 'wrong-approval']) it('leaves the role closed for ' + failure, async () => {
    const server = await modelServer((_x, res) => {
      if (failure === 'text-command') textStream(res, 'TRELLIS_OK list({"kind":"capability"})')
      else if (failure === 'wrong-target') hostToolStream(res, 'list', { kind: 'task' })
      else textStream(res, '{"decision":"approve","reason":"wrong synthetic choice"}')
    }); cleanups.push(server.close)
    const service = new ModelService(), role = failure === 'wrong-approval' ? 'approval' : 'main'
    try {
      service.configure({ type: 'model.configure', configuration: config(server.url), api_key: '', confirm_memory_only: true })
      await expect(service.test('configured', role)).rejects.toBeDefined()
      expect(() => service.acquire('configured', role)).toThrow('explicit synthetic test')
      expect(server.exchanges).toHaveLength(1)
    } finally { service.close() }
  })
  it('cancels an active role test, holds its lock through cleanup and permits an explicit retest', async () => {
    let hanging = true, dispatched = false
    const server = await modelServer(({ body }, res) => { if (hanging) { dispatched = true; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders() } else synthetic(body, res) }); cleanups.push(server.close)
    const service = new ModelService()
    try {
      service.configure({ type: 'model.configure', configuration: config(server.url), api_key: '', confirm_memory_only: true })
      const testing = service.test('configured', 'main', 'cancel-test')
      while (!dispatched) await new Promise(r => setTimeout(r, 2))
      service.cancel('cancel-test')
      expect(() => service.remove('configured')).toThrow('occupied')
      await expect(testing).rejects.toMatchObject({ code: 'MODEL_CANCELLED' })
      expect(() => service.acquire('configured', 'main')).toThrow('explicit synthetic test')
      hanging = false; await service.test('configured', 'main', 'cancel-test')
      expect(() => service.cancel('cancel-test')).toThrow('already ended')
    } finally { service.close() }
  })
  it('reports deadline expiry as timeout, not user cancellation, and never enables the role', async () => {
    const server = await modelServer((_x, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders() }); cleanups.push(server.close)
    const service = new ModelService()
    try {
      service.configure({ type: 'model.configure', configuration: { ...config(server.url), limits: { request_timeout_ms: 30 } }, api_key: '', confirm_memory_only: true })
      await expect(service.test('configured', 'main', 'timeout')).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' })
      expect(() => service.acquire('configured', 'main')).toThrow('explicit synthetic test')
    } finally { service.close() }
  })
  it('rejects whitespace credentials before sending and never silently truncates a large directory', async () => {
    const server = await modelServer((_x, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: Array.from({ length: 1001 }, (_, i) => ({ id: String(i) })) })) }); cleanups.push(server.close)
    const service = new ModelService()
    try {
      await expect(service.probe({ type: 'model.probe', operation_id: 'space', base_url: server.url, api_key: 'secret ', confirm_memory_only: true })).rejects.toThrow('remove whitespace')
      expect(server.exchanges).toHaveLength(0)
      await expect(service.probe({ type: 'model.probe', operation_id: 'large', base_url: server.url, api_key: '', confirm_memory_only: true })).rejects.toMatchObject({ code: 'MODEL_CATALOG_LIMIT' })
    } finally { service.close() }
  })
})
describe('bounded shared model scheduler', () => {
  it('enforces the global active and pending limits across channels', async () => {
    const scheduler = new ModelScheduler(), active: string[] = [], releases: (() => void)[] = [], controllers: AbortController[] = []
    const running = Array.from({ length: defaults.queues.model_active_app }, (_, i) => scheduler.schedule('task-' + i, 'channel-' + i, new AbortController().signal, async () => { active.push(String(i)); await new Promise<void>(r => releases.push(r)) }))
    const pending = Array.from({ length: defaults.queues.model_pending_app }, (_, i) => {
      const controller = new AbortController(); controllers.push(controller)
      return scheduler.schedule('queued-' + i, 'other', controller.signal, async () => { throw new Error('Cancelled queue must never dispatch') }).catch(e => e.code)
    })
    await expect(scheduler.schedule('overflow', 'other', new AbortController().signal, async () => {})).rejects.toMatchObject({ code: 'MODEL_QUEUE_FULL' })
    await new Promise(r => setTimeout(r, 0)); expect(active).toHaveLength(defaults.queues.model_active_app)
    for (const controller of controllers) controller.abort()
    expect(await Promise.all(pending)).toEqual(Array(defaults.queues.model_pending_app).fill('MODEL_CANCELLED'))
    for (const release of releases) release(); await Promise.all(running)
  })
  it('limits channel concurrency, rotates tasks and never sends cancelled queued work', async () => {
    const scheduler = new ModelScheduler(), releases: (() => void)[] = [], started: string[] = []
    const job = (name: string, task: string, signal = new AbortController().signal) => scheduler.schedule(task, 'channel', signal, async () => { started.push(name); await new Promise<void>(r => releases.push(r)); return name })
    const a = job('a', 'A'), b = job('b', 'A'), c = job('c', 'A'), d = job('d', 'B'), cancel = new AbortController(), e = job('e', 'C', cancel.signal)
    const rejection = expect(e).rejects.toMatchObject({ code: 'MODEL_CANCELLED' }); cancel.abort()
    await new Promise(r => setTimeout(r, 0)); expect(started).toEqual(['a', 'b'])
    releases.shift()!(); await new Promise(r => setTimeout(r, 0)); expect(started).toEqual(['a', 'b', 'd'])
    releases.shift()!(); await new Promise(r => setTimeout(r, 0)); expect(started).toEqual(['a', 'b', 'd', 'c'])
    for (const release of releases) release()
    await Promise.all([a, b, c, d]); await rejection
  })
})

describe('configuration locks and role capability invalidation', () => {
  it('closing cancels queued model work before any HTTP request is sent', async () => {
    const server = await modelServer(({ body }, res) => { synthetic(body, res) }); cleanups.push(server.close)
    const scheduler = new ModelScheduler(), service = new ModelService(new ChatAdapter(), scheduler), c = config(server.url)
    service.configure({ type: 'model.configure', configuration: c, api_key: '', confirm_memory_only: true }); await service.test(c.id, 'main')
    const lease = service.acquire(c.id, 'main'), releases: (() => void)[] = []
    const blockers = Array.from({ length: defaults.queues.model_active_channel }, () => scheduler.schedule('blocker', new URL(c.base_url).origin, new AbortController().signal, () => new Promise<void>(r => releases.push(r))))
    await new Promise(r => setTimeout(r, 0))
    const count = server.exchanges.length, queued = service.request(lease, 'queued', [], undefined, new AbortController().signal)
    service.close(); await expect(queued).rejects.toMatchObject({ code: 'MODEL_CANCELLED' })
    for (const release of releases) release(); await Promise.all(blockers)
    expect(server.exchanges).toHaveLength(count); lease.release()
  })
  it('allows an idle unshared configuration to change its channel and requires a fresh role test', async () => {
    const server = await modelServer(({ body }, res) => { synthetic(body, res) }); cleanups.push(server.close)
    const service = new ModelService(), c = config(server.url)
    try {
      service.configure({ type: 'model.configure', configuration: c, api_key: 'old-key', confirm_memory_only: true })
      await service.test(c.id, 'main')
      expect(() => service.configure({ type: 'model.configure', configuration: { ...c, compatibility_profile: 'chat-max-completion-tokens' }, api_key: 'new-key', confirm_memory_only: true })).not.toThrow()
      expect(() => service.acquire(c.id, 'main')).toThrow('explicit synthetic test')
      await service.test(c.id, 'main')
      expect(server.exchanges.at(-1)!.authorization).toBe('Bearer new-key')
    } finally { service.close() }
  })
  it('allows independent idle-model edits but forbids shared credentials while a channel is in use', async () => {
    const server = await modelServer(({ body }, res) => { synthetic(body, res) }); cleanups.push(server.close)
    const service = new ModelService(), a = config(server.url), b = { ...a, id: 'second', wire_model_id: 'other-model' }
    service.configure({ type: 'model.configure', configuration: a, api_key: 'secret', confirm_memory_only: true })
    await service.test(a.id, 'main'); const lease = service.acquire(a.id, 'main')
    expect(() => service.configure({ type: 'model.configure', configuration: b, api_key: 'secret', confirm_memory_only: true })).not.toThrow()
    expect(() => service.configure({ type: 'model.configure', configuration: b, api_key: 'new-secret', confirm_memory_only: true })).toThrow('Shared channel')
    expect(() => service.configure({ type: 'model.configure', configuration: a, api_key: 'secret', confirm_memory_only: true })).toThrow('occupied')
    lease.release(); service.close()
  })
  it('changing model-specific configuration invalidates prior role tests', async () => {
    const server = await modelServer(({ body }, res) => { synthetic(body, res) }); cleanups.push(server.close)
    const service = new ModelService(), c = config(server.url)
    service.configure({ type: 'model.configure', configuration: c, api_key: '', confirm_memory_only: true }); await service.test(c.id, 'main')
    service.configure({ type: 'model.configure', configuration: { ...c, wire_model_id: 'changed-model' }, api_key: '', confirm_memory_only: true })
    expect(() => service.acquire(c.id, 'main')).toThrow('explicit synthetic test'); service.close()
  })
})

 it('classifies upstream errors and retains late usage without returning partial calls', async () => {
  const wire = frame({tool_calls:[{index:0,id:'unfinished',type:'function',function:{name:'write',arguments:'{'}}]}) + 'data: {"error":{"type":"server_error","code":"internal_server_error","message":"private provider body"}}\n\n' + 'data: {"choices":[],"usage":{"prompt_tokens":64370,"completion_tokens":1460}}\n\n' + 'data: [DONE]\n\n'
  const transport = async () => new Response(wire, {headers:{'content-type':'text/event-stream'}})
  await expect(new ChatAdapter(transport as typeof fetch).complete(config('https://example.invalid/v1'), '', [], tool, new AbortController().signal)).rejects.toMatchObject({code:'MODEL_PROVIDER_SERVER_ERROR',partial:true,usage:{prompt_tokens:64370,completion_tokens:1460},message:'MODEL_PROVIDER_SERVER_ERROR'})
 })
it('preserves upstream classification and usage when the stream ends without DONE', async () => {
 const wire='data: {"error":{"type":"server_error"}}\n\n'+'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n'
 await expect(new ChatAdapter((async()=>new Response(wire,{headers:{'content-type':'text/event-stream'}})) as typeof fetch).complete(config('https://example.invalid/v1'),'',[],tool,new AbortController().signal)).rejects.toMatchObject({code:'MODEL_PROVIDER_SERVER_ERROR',usage:{prompt_tokens:11,completion_tokens:2}})
})
it('honors cancellation after upstream failure without waiting for late usage', async () => {
 const controller=new AbortController()
 const stream=new ReadableStream({start(out){out.enqueue(new TextEncoder().encode('data: {"error":{"type":"server_error"},"usage":{"prompt_tokens":13,"completion_tokens":4}}\n\n'));setTimeout(()=>controller.abort(),5);controller.signal.addEventListener('abort',()=>out.error(Error('cancelled')))}})
 await expect(new ChatAdapter((async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}})) as typeof fetch).complete(config('https://example.invalid/v1'),'',[],tool,controller.signal)).rejects.toMatchObject({code:'MODEL_CANCELLED',usage:{prompt_tokens:13,completion_tokens:4}})
})
