import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
import { pdfFixture } from '../helpers/pdf-fixture'
import { openSettings } from '../helpers/settings-ui'

const require = createRequire(import.meta.url)
const candidate = require('../../scripts/windows11-candidate.cjs')
const data = require('../../scripts/windows11-default-data.cjs')
const same = (a: any, b: any) => a?.dev === b?.dev && a?.ino === b?.ino
const absent = (pid: number) => { try { process.kill(pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' } }

test('installed candidate preserves synthetic plugin, PDF, export and recovery across restart or reinstall', async () => {
  test.skip(process.env.TRELLIS_WINDOWS11_CANDIDATE !== '1', 'Explicit approved designated-host candidate mode only')
  test.setTimeout(90000) // Existing PDF business acceptance deadline.
  const paths = await candidate.installed(), owned = await data.inventory()
  const defaultProof = require('../../scripts/verify-default-startup-result.cjs')
  if (owned.absent || !same(owned.rootIdentity, defaultProof.identity.directory) || defaultProof.installed_candidate !== true) throw Error('CANDIDATE_NEW_DEFAULT_REQUIRED')
  const evidence = process.env.TRELLIS_WIN11_EVIDENCE!
  const proofFile = join(evidence, 'candidate-business-state.json')
  const reinstalled = process.env.TRELLIS_CANDIDATE_REINSTALLED === '1'
  const previousProof = reinstalled ? JSON.parse(await readFile(proofFile, 'utf8')) : undefined
  const report: Record<string, any> = { stage: 'launch', passed: false, installed: true, reinstalled,
    application_launches: 0, real_api_requests: 0, directory_cleanup_performed: false, exits: [], node_protocol_errors: [] }
  // Playwright 1.56.1 replaces every unexpected CDP error with "context
  // destroyed". Keep only bounded error categories, never protocol arguments.
  const playwrightRequire = createRequire(createRequire(require.resolve('@playwright/test')).resolve('playwright'))
  const { CRSession } = require(join(dirname(playwrightRequire.resolve('playwright-core/package.json')), 'lib/server/chromium/crConnection.js'))
  const originalSend = CRSession.prototype.send
  CRSession.prototype.send = async function (method: string, parameters: unknown) {
    try { return await originalSend.call(this, method, parameters) }
    catch (error) {
      if (!this._sessionId && ['Runtime.evaluate', 'Runtime.callFunctionOn'].includes(method) && report.node_protocol_errors.length < 8) {
        const message = String((error as Error).message)
        const categories = ['Invalid parameters', 'Cannot find context', 'Could not find object', 'Promise was collected', 'Target closed']
        report.node_protocol_errors.push({ method, category: categories.find(value => message.includes(value)) ?? 'unknown' })
      }
      throw error
    }
  }
  const cwd = await mkdtemp(join(tmpdir(), 'trellis-candidate-business-'))
  let app: ElectronApplication | undefined, page: Page | undefined, mainPid: number | undefined
  let utilityPids: number[] = [], mode: 'pdf' | 'view' = 'pdf', surface: any, capability = ''
  const errors: string[] = [], aclErrors: string[] = []
  const server = await modelServer(({ body }, res) => {
    if (synthetic(body, res)) return
    if (body.messages.at(-1).role === 'tool') return textStream(res, 'CANDIDATE_BUSINESS_DONE')
    if (mode === 'pdf') hostToolStream(res, 'call', { capability, arguments: { resource_id: report.source_resource }, references: [] })
    else hostToolStream(res, 'write', { type: 'surface.update', surface_id: surface.id, expected_revision: surface.revision,
      operations: [{ type: 'view.create', client_ref: 'candidate-learning', slot_id: 'main', bundle: { type: 'inline', bundle: {
        profile: 'managed-v1', html: '<section id="learning"><h2>CANDIDATE_EXPORT_READY</h2></section>', css: '',
        state: { schema: { type: 'object', additionalProperties: false, properties: {} }, initial: {}, compatibility_version: 'v1' },
        forms: [], behaviors: [], references: [], export: [{ id: 'learning', category: 'learning', source: { type: 'element', element_id: 'learning' } }]
      } } } ] })
  }, previousProof?.model_port ?? 0)
  const call = async (request: any): Promise<any> => {
    const value = await page!.evaluate(r => window.trellis.request(r), request)
    if (!value.ok) throw Error(value.error.code)
    return value.data
  }
  async function launch() {
    mainPid = undefined; utilityPids = []
    await data.inventory(owned)
    app = await electron.launch({ executablePath: paths.executable, args: [], cwd, env: { ...candidate.environment(), PATH: '' } })
    report.application_launches++
    let log = ''
    for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', chunk => {
      log = (log + chunk).slice(-65536)
      for (const match of log.matchAll(/WINDOWS_ACL_(?:FAILURE|JOB_NOT_EMPTY|DEADLINE)/g)) if (!aclErrors.includes(match[0])) aclErrors.push(match[0])
    })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.name))
    const facts = await app.evaluate(({ app }) => ({ pid: process.pid,
      utility: app.getAppMetrics().filter(m => m.type === 'Utility').map(m => m.pid),
      home: app.getPath('userData').toLowerCase() === (app.getPath('home') + '\\.trellis').toLowerCase(),
      overrides: Object.keys(process.env).some(key => key.toUpperCase().startsWith('TRELLIS_') || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_RENDERER_URL'].includes(key.toUpperCase())) }))
    mainPid = facts.pid; utilityPids = facts.utility
    expect(facts.home).toBe(true); expect(facts.overrides).toBe(false)
    await data.observeCreated(owned, mainPid)
    await expect.poll(() => call({ type: 'maintenance.status' }), { timeout: 15000 }).toMatchObject({ phase: 'idle', error: null, restore: { error: null }, gc: { enabled: true, error: null } })
    report.environment_confirmed = true
  }
  async function close() {
    utilityPids = await app!.evaluate(({ app }) => app.getAppMetrics().filter(m => m.type === 'Utility').map(m => m.pid))
    expect(utilityPids.length).toBeGreaterThan(0)
    const wrapper = app!.process()
    await page!.close()
    await expect.poll(() => wrapper.exitCode).toBe(0)
    await expect.poll(() => absent(mainPid!)).toBe(true)
    await expect.poll(() => utilityPids.every(absent)).toBe(true)
    report.exits.push({ main_pid: mainPid, utility_count: utilityPids.length, main_exit_confirmed: true, utility_exit_confirmed: true, wrapper_exit_code: wrapper.exitCode })
    await app!.close(); app = undefined; page = undefined
  }
  try {
    let proof: any
    if (reinstalled) {
      proof = previousProof
      if (!same(proof.identity, owned.rootIdentity)) throw Error('CANDIDATE_REINSTALL_DEFAULT_CHANGED')
      await launch()
    } else {
      await launch()
      report.stage = 'synthetic_model'
      await call({ type: 'model.configure', configuration: { id: 'candidate-local', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 1000000, max_output_tokens: 4096, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', confirm_memory_only: true })
      await call({ type: 'model.test', model_id: 'candidate-local', role: 'main', confirm_cost: true })
      await page!.getByRole('button', { name: '＋ 新建', exact: true }).click()
      await page!.getByLabel('任务名称').fill('整批合成验收')
      await page!.getByRole('button', { name: '创建任务', exact: true }).click()
      const task = (await call({ type: 'host.tasks' })).find((value: any) => value.title === '整批合成验收').id
      report.task = task
      report.stage = 'material'
      const source = join(cwd, 'synthetic.pdf'); await writeFile(source, pdfFixture())
      expect(await app!.evaluate(({ dialog }, source) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); return true }, source)).toBe(true)
      const imported = await call({ type: 'material.pick', task_id: task })
      const operation = imported.items[0].operation_id
      await expect.poll(async () => (await call({ type: 'material.status', task_id: task, operation_id: operation })).state).toBe('success')
      report.source_resource = (await call({ type: 'material.status', task_id: task, operation_id: operation })).resource.id
      report.material_imported = true
      report.stage = 'plugin'
      expect(await app!.evaluate(({ dialog }, plugin) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [plugin] }); return true }, paths.plugin)).toBe(true)
      await openSettings(page!, '插件与主流程')
      const panel = page!.getByRole('dialog', { name: '应用设置', exact: true })
      await panel.getByRole('button', { name: '从文件夹导入固定包' }).click()
      await expect(panel).toContainText('trellis.pdf-text')
      await panel.getByRole('button', { name: '核对代码信任' }).click()
      await panel.getByRole('checkbox', { name: /我已核对固定包代码/ }).check()
      await panel.getByRole('button', { name: '确认代码信任', exact: true }).click()
      await panel.getByRole('button', { name: '核对启用依赖' }).click()
      await panel.getByRole('button', { name: '确认共同启用' }).click()
      await expect(panel).toContainText('当前可用')
      await panel.getByRole('button', { name: /^返回工作区/ }).click()
      capability = (await call({ type: 'task.query', task_id: task, query: { type: 'list', input: { kind: 'capability' } } })).items.find((item: any) => !item.id.startsWith('builtin:')).id
      const submit = async (text: string) => {
        const request = await call({ type: 'request.submit', task_id: task, text, model_config_id: 'candidate-local', resource_ids: mode === 'pdf' ? [report.source_resource] : [], import_ids: [] })
        await expect.poll(async () => (await call({ type: 'request.status', task_id: task, request_id: request.request_id })).run_state).toBe('completed')
      }
      await submit('Extract only the synthetic PDF as text.')
      const calls = (await call({ type: 'task.query', task_id: task, query: { type: 'list', input: { kind: 'call' } } })).items
      const result = (await call({ type: 'task.query', task_id: task, query: { type: 'read', input: { target: { kind: 'call', id: calls[0].id } } } })).data.result_data
      expect(result).toMatchObject({ execution: 'success', delivery: 'delivered', data: { extracted_pages: 2, partial: false } })
      const output = result.data.resource_id
      expect(await readFile(join(owned.root, 'resources', output), 'utf8')).toContain('Trellis PDF text two')
      report.plugin_called = true; report.pdf_extracted = true
      report.stage = 'export'
      mode = 'view'; surface = (await call({ type: 'task.snapshot', task_id: task })).surface
      await submit('Create the synthetic offline learning view.')
      const prepared = await call({ type: 'export.prepare', task_id: task, answer_ids: [] })
      await expect.poll(async () => (await call({ type: 'export.status', task_id: task, operation_id: prepared.id })).phase).toBe('preview')
      const target = join(cwd, 'synthetic-export.html')
      expect(await app!.evaluate(({ dialog }, target) => { (dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: target }); return true }, target)).toBe(true)
      await call({ type: 'export.save', task_id: task, operation_id: prepared.id, partial: false })
      expect((await call({ type: 'export.status', task_id: task, operation_id: prepared.id })).phase).toBe('saved')
      const html = await readFile(target, 'utf8')
      expect(html).toContain('CANDIDATE_EXPORT_READY'); expect(html).not.toMatch(/<script|<input|<textarea/)
      report.export_saved = true
      report.stage = 'recovery'
      const begin = await call({ type: 'maintenance.begin' })
      const point = (await call({ type: 'maintenance.create', token: begin.reservation.token, inputs_saved: true, replace_id: null })).active
      const extra = await call({ type: 'task.create', title: '恢复时移除的合成任务' })
      const reservation = await call({ type: 'maintenance.begin' })
      await call({ type: 'maintenance.restore', token: reservation.reservation.token, point_id: point.id, database_sha256: point.database_sha256, inputs_saved: true, confirm_replace_newer_data: true })
      expect((await call({ type: 'host.tasks' })).some((value: any) => value.id === extra.task.id)).toBe(false)
      report.recovery_restored = true
      proof = { task, source_resource: report.source_resource, output, export_operation: prepared.id, recovery_point: point.id, identity: owned.rootIdentity, model_port: Number(new URL(server.url).port) }
      await writeFile(proofFile, JSON.stringify(proof, null, 2) + '\n')
      const before = server.exchanges.length
      await close(); await launch()
      expect(server.exchanges.length).toBe(before)
    }
    report.stage = 'restored_state'
    expect((await call({ type: 'host.tasks' })).some((value: any) => value.id === proof.task)).toBe(true)
    expect((await call({ type: 'plugin.list', task_id: proof.task })).items.find((item: any) => item.id === 'trellis.pdf-text')).toMatchObject({ trusted: true, enabled: true })
    const restored = await call({ type: 'task.query', task_id: proof.task, query: { type: 'read', input: { target: { kind: 'resource', id: proof.output } } } })
    expect(restored.data.provenance.input.id).toBe(proof.source_resource)
    expect((await call({ type: 'maintenance.status' })).active.id).toBe(proof.recovery_point)
    expect((await call({ type: 'export.status', task_id: proof.task, operation_id: proof.export_operation })).phase).toBe('saved')
    await page!.screenshot({ path: test.info().outputPath('candidate.png') })
    await close(); await data.inventory(owned)
    if (reinstalled) expect(server.exchanges).toHaveLength(0)
    expect(errors).toEqual([]); expect(aclErrors).toEqual([])
    report.state_restored = true; report.no_replay = true; report.acl_errors = aclErrors; report.stage = 'ready'; report.passed = true
  } catch (error) {
    report.failed_stage = report.stage; report.stage = 'failed'
    report.error = (error as Error).message.match(/\b[A-Z][A-Z0-9_]{3,80}\b/)?.[0] ?? 'CANDIDATE_BUSINESS_FAILED'
    if (page && !page.isClosed()) {
      await page.screenshot({ path: test.info().outputPath('candidate-failure.png') }).catch(() => {})
      try { const state = await call({ type: 'maintenance.status' }); report.maintenance = { phase: state.phase, error: state.error, restore: state.restore?.error, gc: state.gc?.error } } catch {}
    }
    throw error
  } finally {
    if (app) {
      try { await app.close() } catch { report.cleanup_error = 'CANDIDATE_CLOSE_FAILED' }
      report.failure_exit = { main_pid: mainPid ?? null, main_exit_confirmed: mainPid ? absent(mainPid) : null, utility_exit_confirmed: utilityPids.length ? utilityPids.every(absent) : null }
    }
    report.acl_errors = aclErrors
    CRSession.prototype.send = originalSend
    await server.close()
    await writeFile(test.info().outputPath('candidate-business.json'), JSON.stringify(report, null, 2) + '\n')
  }
})
