import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeStore } from '../../src/runtime/store'
import { ModelService } from '../../src/runtime/model/service'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
import type { Bundle } from '../../src/shared/contracts.generated'
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function until(check: () => boolean) { const start = Date.now(); while (!check()) { if (Date.now() - start > 3000) throw new Error('condition timed out'); await new Promise(done => setTimeout(done, 5)) } }

for (const decision of ['approve', 'deny', 'escalate', 'invalid'] as const) it('isolated assisted View reset: ' + decision, async () => {
  let assessments = 0, source: ReturnType<RuntimeStore['snapshot']>
  const server = await modelServer(({ body }, res) => {
    if (synthetic(body, res)) return
    if (!body.tools) {
      assessments++
      expect(body.messages).toHaveLength(2)
      const input = JSON.parse(body.messages[1].content)
      expect(input.action.type).toBe('surface.update')
      expect(input.permission).toContain('separate human confirmation')
      expect(JSON.stringify(body.messages)).not.toContain('PRIVATE_OLD_RUN_SENTINEL')
      textStream(res, decision === 'invalid' ? 'invalid response' : JSON.stringify({ decision, reason: 'synthetic replacement assessment' })); return
    }
    if (body.messages.at(-1).role === 'tool') { textStream(res, 'VIEW_RUN_ENDED'); return }
    const view = source.views[0]!, next = structuredClone(view.bundle)
    next.state.initial = { answer: 'new initial' }; next.state.compatibility_version = 'question-v2'
    hostToolStream(res, 'write', { type: 'surface.update', surface_id: source.surface.id, expected_revision: source.surface.revision, operations: [{ type: 'view.replace', view_id: view.id, expected_view_revision: view.revision, bundle: { type: 'inline', bundle: next }, state_transition: { type: 'reset', expected_state_revision: view.state_revision, initial: next.state.initial } }] })
  })
  cleanups.push(server.close)
  const directory = mkdtempSync(join(tmpdir(), 'pliuna-view-assisted-')), models = new ModelService()
  const store = new RuntimeStore(directory, models, { viewReplacement: true })
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const task = store.create('辅助审批替换'), fixture = store.start(task.task.id, 'PRIVATE_OLD_RUN_SENTINEL', 'fixture', [])
  const bundle: Bundle = { profile: 'managed-v1', html: '<label for="a">答案</label><textarea id="a"></textarea>', css: '', state: { schema: { type: 'object', properties: { answer: { type: 'string' } }, additionalProperties: false }, initial: { answer: 'saved answer' }, compatibility_version: 'question-v1' }, forms: [], behaviors: [{ type: 'input', element_id: 'a', field: '/answer', control: 'textarea' }], references: [], export: [] }
  store.modelTool(task.task.id, fixture, { type: 'write', input: { type: 'surface.update', surface_id: task.surface.id, expected_revision: 1, operations: [{ type: 'view.create', client_ref: 'v', slot_id: 'main', bundle: { type: 'inline', bundle } }] } })
  store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: fixture })
  models.configure({ type: 'model.configure', configuration: { id: 'main', base_url: server.url, wire_model_id: 'wire-model', context_tokens: 1000000, max_output_tokens: 1024, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only-sentinel', confirm_memory_only: true })
  await models.test('main', 'main'); await models.test('main', 'approval')
  store.handle({ type: 'approval.configure', mode: 'assisted', model_id: 'main', confirm_external_processing: true })
  source = store.snapshot(task.task.id)
  store.start(task.task.id, 'replace view with reset', 'main', [])
  await until(() => !!store.snapshot(task.task.id).approvals.length)
  if (decision === 'invalid' || decision === 'escalate') {
    await until(() => store.snapshot(task.task.id).approvals[0]!.handling === 'awaiting_human')
    expect(store.snapshot(task.task.id).approvals).toHaveLength(1)
    store.handle({ type: 'approval.decide', task_id: task.task.id, approval_id: store.snapshot(task.task.id).approvals[0]!.id, decision: 'approve' })
  }
  if (decision === 'deny') {
    await until(() => store.snapshot(task.task.id).runs[0]!.state === 'completed')
    expect(store.snapshot(task.task.id).surface_updates).toHaveLength(0)
  } else {
    await until(() => !!store.snapshot(task.task.id).surface_updates.length)
    const update = store.snapshot(task.task.id).surface_updates[0]!
    expect(update.reset_requires_confirmation).toBe(true)
    await expect(store.handle({ type: 'surface.respond', task_id: task.task.id, action_id: update.action_id, proceed: true, confirm_discard: false })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
    expect(store.snapshot(task.task.id).views[0]!.draft).toEqual({ answer: 'saved answer' })
    await store.handle({ type: 'surface.respond', task_id: task.task.id, action_id: update.action_id, proceed: true, confirm_discard: true })
    await until(() => store.snapshot(task.task.id).runs[0]!.state === 'completed')
  }
  expect(store.snapshot(task.task.id).views[0]!).toMatchObject({ revision: decision === 'deny' ? 1 : 2, draft: { answer: decision === 'deny' ? 'saved answer' : 'new initial' } })
  expect(assessments).toBe(1)
})
