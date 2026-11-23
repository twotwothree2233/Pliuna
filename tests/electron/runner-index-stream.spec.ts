import { artifactDraft } from '../helpers/producer-draft'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { frame, modelInputFromHost, modelServer, synthetic } from '../helpers/model-server'
import type { Bundle } from '../../src/shared/contracts.generated'
import type { ArtifactCandidate, ArtifactIndex, CompositionBatch, DeliveryRecord, ExecutionScope, ContentPlan, HostRequest, Outline, OutlineSection, PublicationEntry, Snapshot, WorkDependency } from '../../src/shared/types'
import type { PublicationOperation } from '../../src/runtime/runner/publication-state'

const require = createRequire(import.meta.url), executablePath: string = require('electron')
type RunnerLimits = typeof import('../../src/runtime/runner/limits').RUNNER_LIMITS
interface Binding { owner: ExecutionScope; plan_revision: number; dependencies: WorkDependency[]; goal: ContentPlan; requirement_ids: string[]; sections: OutlineSection[] }
interface CollatorInput { batch: CompositionBatch; outline: Outline; indexes: ArtifactIndex[] }
interface FixedBatchRead {
  batch: CompositionBatch | null
  operation: PublicationOperation | null
  action: { id: string; task_id: string; run_id: string; state: string; result: string } | undefined
  mappings: PublicationEntry[]
  deliveries: DeliveryRecord[]
  rebuilds: string[]
}

function respond(response: ServerResponse, delta: unknown, finish = 'stop'): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(frame(delta) + frame({}, finish) + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 400, completion_tokens: 80 } })}\n\n` + 'data: [DONE]\n\n')
}

async function runnerLimits(): Promise<RunnerLimits> {
  const esbuild = createRequire(require.resolve('vite'))('esbuild')
  const built = await esbuild.build({ entryPoints: [resolve('src/runtime/runner/limits.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
  const loaded = { exports: {} as { RUNNER_LIMITS: RunnerLimits } }
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
  return loaded.exports.RUNNER_LIMITS
}

test('a fixed first batch publishes while unrelated indexes continue arriving', async () => {
  test.setTimeout(120000)
  const RUNNER_LIMITS = await runnerLimits()
  const sourceResources = new Map<number, string>()
  const total = 8, collators: { input: CollatorInput; bytes: number; text: string }[] = [], failures: string[] = []
  let first: { response: ServerResponse; plan: unknown } | undefined
  let last: { response: ServerResponse; name: number } | undefined
  const bundle = (name: number): Bundle => ({
    profile: 'managed-v1', html: `<section id="part"><h2>STREAM_${name}_PUBLISHED</h2><p>STREAM_BODY_${name}</p></section>`, css: '',
    state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'static-v1' },
    forms: [], behaviors: [], references: [], export: [{ id: 'part', category: 'learning', source: { type: 'element', element_id: 'part' } }]
  })
  const resource = (response: ServerResponse, name: number) => respond(response, {
    role: 'assistant', content: '', tool_calls: [{ index: 0, id: `resource-stream-${name}`, type: 'function', function: {
      name: 'write', arguments: JSON.stringify(modelInputFromHost('write', { type: 'resource.create', display_name: `stream-${name}.json`, content: { type: 'json', value: bundle(name) } }))
    } }]
  }, 'tool_calls')
  const server = await modelServer(({ body }, response) => {
    try {
      if (synthetic(body, response)) return
      if (body.messages[0]?.content.startsWith('Route the latest user turn')) {
        respond(response, { role: 'assistant', content: JSON.stringify({ kind: 'new' }) }); return
      }
      if (body.messages[0]?.content.startsWith('You are the Collator.')) {
        const input = JSON.parse(body.messages.find((message: any) => message.role === 'user').content) as CollatorInput
        const text = JSON.stringify(body.messages)
        collators.push({ input, text, bytes: Buffer.byteLength(text) })
        const { batch, outline, indexes } = input
        const plan = { task_id: batch.task_id, run_id: batch.run_id, batch_id: batch.batch_id, composition_version: batch.composition_version, intents: indexes.map(index => {
          const section = outline.sections.find(section => section.section_id === index.section_id)!
          return { artifact: { task_id: index.task_id, artifact_id: index.artifact_id, artifact_revision: index.artifact_revision }, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key, slot_id: 'main', layout_mode: 'column', width_constraint: index.width_constraint }
        }) }
        if (collators.length === 1) { first = { response, plan }; return }
        respond(response, { role: 'assistant', content: JSON.stringify(plan) }); return
      }
      const prompt = body.messages.find((message: any) => message.role === 'system' && message.content.includes('Bound data: '))?.content as string | undefined
      if (!prompt) throw Error('Missing real producer binding')
      const binding = JSON.parse(prompt.slice(prompt.indexOf('Bound data: ') + 'Bound data: '.length)) as Binding
      const text = [...body.messages].reverse().find((message: any) => message.role === 'user').content as string
      const name = Number(/STREAM_REQUEST_(\d+)/.exec(text)?.[1])
      if (!Number.isSafeInteger(name) || name < 0 || name >= total) throw Error('Unexpected stream goal')
      const latest = body.messages.at(-1)
      if (latest.role !== 'tool') {
        if (name === total - 1) { last = { response, name }; return }
        resource(response, name); return
      }
      const created = JSON.parse(latest.content)
      expect(created).toMatchObject({ execution: 'success', data: { id: expect.any(String) } })
      const { owner, plan_revision, dependencies, requirement_ids, sections } = binding
      if (owner.purpose !== 'production') throw Error('Expected production scope')
      const section = sections[0]!, id = created.data.id as string
      sourceResources.set(name, id)
      const candidate: ArtifactCandidate = {
        candidate_id: `stream-candidate-${name}`, task_id: owner.task_id, request_id: owner.request_id, intent_revision: owner.intent_revision,
        run_id: owner.run_id, work_id: owner.work_id, attempt_id: owner.attempt_id, artifact_id: `stream-artifact-${name}`, base_artifact_revision: 0,
        plan_revision, bundle_resource_id: id, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key,
        presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: owner.task_id, kind: 'resource', id },
        requirement_ids, unresolved: [], dependencies
      }
      respond(response, { role: 'assistant', content: JSON.stringify({ version: 1, complete: true, answer: `STREAM_FINAL_${name}`, artifacts: [artifactDraft(candidate)], requirement_ids, unresolved: [] }) })
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
      if (!response.headersSent) response.writeHead(500)
      response.end('Invalid deterministic stream fixture')
    }
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-index-stream-'))
  const app = await electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory, PLIUNA_TEST_RUNNER: 'dual', PLIUNA_TEST_RUNNER_COLLATOR: 'model' } })
  let inspectSnapshot: (() => Promise<Snapshot>) | undefined
  try {
    const page = await app.firstWindow(), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const call = <T,>(request: HostRequest): Promise<T> => page.evaluate(async request => {
      const response = await window.pliuna.request(request)
      if (!response.ok) throw Error(response.error.code)
      return response.data as T
    }, request)
    await call({ type: 'model.configure', configuration: { id: 'stream-main', base_url: server.url, wire_model_id: 'stream-wire', context_tokens: 100000, max_output_tokens: 4096, compatibility_profile: 'chat-max-tokens' }, api_key: 'isolated-stream-key', confirm_memory_only: true })
    await call({ type: 'model.test', model_id: 'stream-main', role: 'main', confirm_cost: true })
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page.getByLabel('任务名称').fill('持续索引与固定批次')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call<{ id: string }[]>({ type: 'host.tasks' }))[0]!.id
    const snapshot = () => call<Snapshot>({ type: 'task.snapshot', task_id: task })
    inspectSnapshot = snapshot
    const submit = (name: number) => call({ type: 'request.submit', task_id: task, text: `STREAM_REQUEST_${name}：完成独立章节。`, model_config_id: 'stream-main', resource_ids: [], import_ids: [] })
    const approve = async () => {
      for (const approval of (await snapshot()).approvals.filter(item => item.decision === 'pending' && item.validity === 'valid')) {
        await call({ type: 'approval.decide', task_id: task, approval_id: approval.id, decision: 'approve' })
      }
      for (const update of (await snapshot()).surface_updates) await call({ type: 'surface.respond', task_id: task, action_id: update.action_id, proceed: true, confirm_discard: false })
      return snapshot()
    }
    await submit(0)
    await expect.poll(async () => { await approve(); expect(failures).toEqual([]); return Boolean(first) }, { timeout: 20000 }).toBe(true)
    const fixed = structuredClone(collators[0]!.input.batch)
    expect(fixed.indexes).toHaveLength(1)
    expect(fixed.indexes[0]!.artifact_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(collators[0]!.input.indexes[0]!.bundle_resource_id).toBe(sourceResources.get(0))
    expect(fixed.operation_id).toEqual(expect.any(String))
    expect(fixed.action_id).toEqual(expect.any(String))
    const inspectFixed = (): Promise<FixedBatchRead> => app.evaluate((_electron, input) => {
      const req = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json'), Database = req('better-sqlite3')
      const database = new Database(input.directory + '/pliuna.sqlite', { readonly: true, fileMustExist: true })
      try {
        return database.transaction(() => {
          const stored = database.prepare('SELECT payload_json FROM runner_batches WHERE task_id=? AND batch_id=?').get(input.task, input.batch)
          const publication = database.prepare('SELECT state,payload_json,result_json FROM runner_publications WHERE task_id=? AND operation_id=?').get(input.task, input.operation)
          const payload = publication ? JSON.parse(publication.payload_json) : null
          return {
            batch: stored ? JSON.parse(stored.payload_json) as CompositionBatch : null,
            operation: publication ? { registration: payload.registration, preparation: payload.preparation ?? null, state: publication.state, result: publication.result_json ? JSON.parse(publication.result_json) : null } as PublicationOperation : null,
            action: database.prepare('SELECT id,task_id,run_id,state,result FROM actions WHERE task_id=? AND id=?').get(input.task, input.action) as { id: string; task_id: string; run_id: string; state: string; result: string } | undefined,
            mappings: database.prepare('SELECT payload_json FROM runner_view_mappings WHERE task_id=? AND batch_id=? ORDER BY artifact_id').all(input.task, input.batch).map((row: { payload_json: string }) => JSON.parse(row.payload_json) as PublicationEntry),
            deliveries: database.prepare("SELECT payload_json FROM runner_deliveries WHERE task_id=? AND purpose='composition' AND json_extract(payload_json,'$.batch_id')=?").all(input.task, input.batch).map((row: { payload_json: string }) => JSON.parse(row.payload_json) as DeliveryRecord),
            rebuilds: database.prepare("SELECT batch_id FROM runner_batches WHERE task_id=? AND json_extract(payload_json,'$.previous_batch_id')=?").all(input.task, input.batch).map((row: { batch_id: string }) => row.batch_id)
          }
        })()
      } finally { database.close() }
    }, { directory, task, batch: fixed.batch_id, operation: fixed.operation_id!, action: fixed.action_id! })
    for (let name = 1; name < total - 1; name++) {
      await submit(name)
      await expect.poll(async () => (await approve()).views.some(view => view.bundle.html.includes(`STREAM_${name}_PUBLISHED`)), { timeout: 20000 }).toBe(true)
      expect((await snapshot()).views.every(view => !view.bundle.html.includes('STREAM_0_PUBLISHED'))).toBe(true)
    }
    await submit(total - 1)
    await expect.poll(() => Boolean(last)).toBe(true)
    const waiting = await snapshot(), held = await inspectFixed()
    expect(waiting.runner!.scope!.composition_version).toBeGreaterThan(fixed.composition_version)
    expect(held.batch).toEqual({ ...fixed, state: held.batch!.state })
    expect(held.operation).toBeNull()
    expect(held.mappings).toEqual([])
    expect(held.deliveries).toEqual([])
    expect(held.rebuilds).toEqual([])
    expect(first).toBeDefined()
    respond(first!.response, { role: 'assistant', content: JSON.stringify(first!.plan) }); first = undefined
    await expect.poll(async () => (await approve()).views.some(view => view.bundle.html.includes('STREAM_0_PUBLISHED')), { timeout: 20000 }).toBe(true)
    const early = await snapshot()
    expect(last).toBeDefined()
    expect(early.runner!.scope!.state).not.toBe('complete')
    expect(early.runner!.scope!.required_content_count).toBe(total)
    expect(early.runner!.scope!.unresolved_count).toBeGreaterThan(0)
    const published = await inspectFixed()
    expect(published.batch).toEqual({ ...fixed, state: published.batch!.state })
    expect(published.operation).toMatchObject({
      state: 'published',
      registration: { operation_id: fixed.operation_id, action_id: fixed.action_id, batch_id: fixed.batch_id, plan: { run_id: fixed.run_id, composition_version: fixed.composition_version } },
      result: { operation_id: fixed.operation_id, action_id: fixed.action_id, batch_id: fixed.batch_id, state: 'published' }
    })
    expect(published.operation!.registration.plan.intents.map(intent => intent.artifact)).toEqual(fixed.indexes)
    expect(published.action).toEqual({ id: fixed.action_id, task_id: task, run_id: fixed.run_id, state: 'ended', result: 'success' })
    expect(published.deliveries).toHaveLength(1)
    expect(published.deliveries[0]).toMatchObject({ purpose: 'composition', batch_id: fixed.batch_id, run_id: fixed.run_id, composition_version: fixed.composition_version, delivery_id: published.operation!.result!.state === 'published' ? published.operation!.result!.delivery_id : undefined })
    expect(published.rebuilds).toEqual([])
    const original = early.views.find(view => view.bundle.html.includes('STREAM_0_PUBLISHED'))!
    expect(published.mappings).toHaveLength(1)
    expect(published.mappings[0]).toMatchObject({ ...fixed.indexes[0], batch_id: fixed.batch_id, view_id: original.id, view_revision: original.revision, state_revision: original.state_revision })
    resource(last!.response, last!.name); last = undefined
    await expect.poll(async () => (await approve()).runner?.scope?.state, { timeout: 30000 }).toBe('complete')
    const complete = await snapshot()
    expect(complete.views).toHaveLength(total)
    expect(new Set(complete.views.map(view => view.id)).size).toBe(total)
    expect(complete.views.find(view => view.id === original.id)).toMatchObject({ revision: original.revision, bundle: original.bundle })
    const retained = await inspectFixed()
    expect(retained.batch).toEqual({ ...fixed, state: retained.batch!.state })
    expect(retained.operation).toEqual(published.operation)
    expect(retained.mappings).toEqual(published.mappings)
    expect(retained.deliveries).toEqual(published.deliveries)
    expect(retained.rebuilds).toEqual([])
    for (let name = 0; name < total; name++) expect(complete.views.filter(view => view.bundle.html.includes(`STREAM_${name}_PUBLISHED`))).toHaveLength(1)
    expect(collators.length).toBeGreaterThanOrEqual(4)
    for (const captured of collators) {
      expect(captured.bytes).toBeLessThanOrEqual(RUNNER_LIMITS.index.page_bytes)
      expect(captured.text).not.toMatch(/STREAM_BODY_|STREAM_FINAL_/)
      expect(captured.input.indexes.length).toBeLessThanOrEqual(RUNNER_LIMITS.composition.batch_fragments)
    }
    expect(failures).toEqual([])
    expect(errors).toEqual([])
    await page.screenshot({ path: test.info().outputPath('continuous-index-arrivals.png') })
  } catch (error) {
    const path = test.info().outputPath('stream-failure.json')
    await writeFile(path, JSON.stringify({ failures, collators, exchanges: server.exchanges.map(exchange => ({ first: exchange.body.messages[0]?.content?.slice(0, 80), last: exchange.body.messages.at(-1) })), snapshot: await inspectSnapshot?.() }))
    await test.info().attach('stream-failure.json', { path, contentType: 'application/json' })
    throw error
  } finally {
    first?.response.destroy(); last?.response.destroy()
    await app.close(); await server.close(); await rm(directory, { recursive: true, force: true })
  }
})
