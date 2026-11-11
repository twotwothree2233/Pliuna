import { _electron as electron, expect, test } from '@playwright/test'
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const executablePath: string = createRequire(import.meta.url)('electron')

const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]!

test('keeps preflight responsive, cancels safely, saves a full document and forgets checks on isolated restart', async () => {
  test.setTimeout(180000)
  const sample = JSON.parse(execFileSync(process.execPath, ['scripts/export-check-sample.mjs'], { encoding: 'utf8' }))
  const root = await mkdtemp(join(tmpdir(), 'pliuna-async-export-desktop-'))
  await cp(sample.root, root, { recursive: true, filter: path => !path.endsWith('runtime-owner.sqlite') })
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: root, PLIUNA_ENABLE_VIEW_REPLACEMENT: '1' } })
  let app = await launch(), page = await app.firstWindow(), network = 0
  const errors: string[] = [], attach = async () => {
    page.on('pageerror', e => errors.push(e.message))
    await app.evaluate(({ session }) => { (globalThis as any).__network = 0; session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => { (globalThis as any).__network++; done({ cancel: true }) }) })
  }
  const call = async (request: any): Promise<any> => { const response = await page.evaluate(q => window.pliuna.request(q), request); if (!response.ok) throw Error(response.error.code); return response.data }
  const wait = async (id: string) => {
    let state: any
    await expect.poll(async () => { state = await call({ type: 'export.check.status', task_id: sample.task, check_id: id }); return state.exited }, { timeout: 30000, intervals: [20, 50, 100] }).toBe(true)
    return state
  }
  try {
    await attach()
    const task = sample.task, initial = await call({ type: 'task.snapshot', task_id: task }), view = initial.views[0], selection = { task_id: task, answer_ids: [], view_ids: sample.views, expected_revision: initial.surface.revision }
    // New synthetic credentials are never configured; no model endpoint is involved.
    expect(await call({ type: 'model.list' })).toMatchObject({ models: [] })
    await page.getByRole('button', { name: /Async export acceptance synthetic/ }).click()
    await page.getByRole('button', { name: '导出', exact: true }).click()
    const ui: number[] = []
    for (let i = 0; i < 20; i++) {
      const start = Date.now()
      await page.getByRole('button', { name: '检查当前导出选择', exact: true }).click()
      await expect(page.getByLabel('后台预检状态')).toContainText(/启动中|检查中|检查完成/)
      ui.push(Date.now() - start)
      await expect(page.getByRole('status').filter({ hasText: '完整性检查通过' })).toBeVisible()
    }
    expect(p95(ui)).toBeLessThanOrEqual(200)
    // A selection change cancels and hides the old result without disabling selection.
    await page.getByRole('button', { name: '检查当前导出选择', exact: true }).click()
    await page.getByLabel('片段 lesson · learning').first().uncheck()
    await expect(page.getByLabel('导出选择检查')).toHaveCount(0)
    await page.getByRole('button', { name: '关闭导出', exact: true }).click()
    await page.waitForTimeout(150)
    const results: any[] = [], baselineMetrics = await app.evaluate(({ app }) => app.getAppMetrics().map(p => ({ type: p.type, pid: p.pid, memory: p.memory })))
    for (const count of [1, 10, 50]) {
      const samples: any[] = []
      for (let i = 0; i <= (count === 50 ? 5 : 20); i++) {
        const measured: any = await page.evaluate(async ({ selection, view, i }) => {
          const start = performance.now(), invoke = async (request: any) => { const value = await window.pliuna.request(request); if (!value.ok) throw Error(value.error.code); return value.data as any }
          const inspection = invoke({ type: 'export.check.start', ...selection }).then(data => ({ data, start_ms: performance.now() - start }))
          const independent = invoke({ type: 'export.list', task_id: selection.task_id }).then(() => performance.now() - start)
          const draft = invoke({ type: 'draft.save', task_id: selection.task_id, view_id: view.id, view_revision: view.revision, expected_state_revision: view.state_revision, fields: [{ path: '/draft', value: 'SAVED_DURING_CHECK_' + i }] }).then(() => performance.now() - start)
          const [check, read_ms, draft_ms] = await Promise.all([inspection, independent, draft])
          await new Promise(resolve => setTimeout(resolve, 20))
          const during = performance.now()
          await invoke({ type: 'export.list', task_id: selection.task_id })
          return { ...check, read_ms, draft_ms, during_conversion_read_ms: performance.now() - during }
        }, { selection: { ...selection, view_ids: sample.views.slice(0, count) }, view, i })
        const state = await wait(measured.data.id); expect(state).toMatchObject({ phase: 'ready', complete: true, issues: [], exited: true })
        samples.push({ warmup: i === 0, start_ms: measured.start_ms, independent_read_ms: measured.read_ms, draft_save_ms: measured.draft_ms, during_conversion_read_ms: measured.during_conversion_read_ms, ...state.metrics })
        view.state_revision = (await call({ type: 'task.snapshot', task_id: task })).views[0].state_revision
      }
      const warm = samples.slice(1)
      if (count !== 50) { expect(p95(warm.map(s => s.independent_read_ms))).toBeLessThanOrEqual(200); expect(p95(warm.map(s => s.draft_save_ms))).toBeLessThanOrEqual(1000); expect(p95(warm.map(s => s.during_conversion_read_ms))).toBeLessThanOrEqual(200) }
      else { expect(Math.max(...warm.map(s => s.independent_read_ms))).toBeLessThanOrEqual(200); expect(Math.max(...warm.map(s => s.draft_save_ms))).toBeLessThanOrEqual(1000); expect(Math.max(...warm.map(s => s.during_conversion_read_ms))).toBeLessThanOrEqual(200) }
      results.push({ views: count, table_rows: count * 1800, samples })
    }
    const cancellations: any[] = []
    for (let i = 0; i < 20; i++) {
      const started = await call({ type: 'export.check.start', ...selection })
      const measured = await page.evaluate(async ({ task, id }) => {
        const start = performance.now(), response = await window.pliuna.request({ type: 'export.check.cancel', task_id: task, check_id: id })
        if (!response.ok) throw Error(response.error.code); return { ack_ms: performance.now() - start, status: response.data as any }
      }, { task, id: started.id })
      expect(measured.status).toMatchObject({ phase: 'cancelling', exited: false })
      const state = await wait(started.id); expect(state).toMatchObject({ phase: 'cancelled', exited: true }); expect(state.complete).toBeUndefined()
      cancellations.push({ ack_ms: measured.ack_ms, ack_phase: measured.status.phase, exited: state.exited })
    }
    expect(p95(cancellations.map(s => s.ack_ms))).toBeLessThanOrEqual(200)
    const checked = await call({ type: 'export.check.start', ...selection }); await wait(checked.id)
    expect(await call({ type: 'export.list', task_id: task })).toEqual([])
    const job = await call({ type: 'export.prepare', ...selection })
    await expect.poll(async () => (await call({ type: 'export.status', task_id: task, operation_id: job.id })).phase, { timeout: 60000 }).toBe('preview')
    const preview = await call({ type: 'export.preview', task_id: task, operation_id: job.id })
    expect(preview.html.match(/ROW-1799/g)).toHaveLength(50); expect(preview.html.match(/<tr>/g)).toHaveLength(90000); expect(preview.html).not.toContain('SAVED_DURING_CHECK')
    const target = join(root, 'async-export-complete.html')
    await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }) }, target)
    expect(await call({ type: 'export.save', task_id: task, operation_id: job.id, partial: false })).toMatchObject({ phase: 'saved', pinned: false })
    const html = await readFile(target), before = await call({ type: 'task.snapshot', task_id: task })
    expect(before.views[0].draft.draft).toContain('SAVED_DURING_CHECK')
    const metrics = await app.evaluate(({ app }) => app.getAppMetrics().map(p => ({ type: p.type, pid: p.pid, memory: p.memory })))
    network += await app.evaluate(() => (globalThis as any).__network)
    await app.close(); app = await launch(); page = await app.firstWindow(); await attach()
    const absent = await page.evaluate(q => window.pliuna.request(q), { type: 'export.check.status' as const, task_id: task, check_id: checked.id })
    expect(absent).toMatchObject({ ok: false, error: { code: 'EXPORT_CHECK_NOT_FOUND' } })
    const after = await call({ type: 'task.snapshot', task_id: task })
    expect(after.views).toEqual(before.views); expect(after.answers).toEqual(before.answers); expect(after.records).toEqual(before.records); expect(await readFile(target)).toEqual(html)
    expect(await call({ type: 'export.status', task_id: task, operation_id: job.id })).toMatchObject({ phase: 'saved', pinned: false })
    network += await app.evaluate(() => (globalThis as any).__network); expect(network).toBe(0); expect(errors).toEqual([])
    const report = { platform: process.platform + '-' + process.arch, ui_ack_samples_ms: ui, ui_ack_p95_ms: p95(ui), cancellation_samples: cancellations, cancellation_p95_ms: p95(cancellations.map(s => s.ack_ms)), scenarios: results, app_metrics_before: baselineMetrics, app_metrics_after: metrics, source_bytes_per_view: sample.bundle_bytes, html_bytes: html.length, selected_views: 50, table_rows: 90000, restart_exact: true, ephemeral_check_forgotten: true, real_api_requests: 0, automatic_http_requests: network, renderer_errors: errors }
    await writeFile(test.info().outputPath('pliuna-async-export-performance.json'), JSON.stringify(report, null, 2)); await writeFile(test.info().outputPath('pliuna-async-export-desktop-scene.json'), JSON.stringify({ root, checked: checked.id, task, job: job.id }))
    console.log('ASYNC_EXPORT_PERFORMANCE', JSON.stringify({ ui_p95_ms: report.ui_ack_p95_ms, cancel_p95_ms: report.cancellation_p95_ms, scenarios: results.map(r => ({ views: r.views, independent_read_max_ms: Math.max(...r.samples.slice(1).map((s: any) => s.independent_read_ms)), start_max_ms: Math.max(...r.samples.slice(1).map((s: any) => s.start_ms)) })), html_bytes: html.length, real_api_requests: 0 }))
    console.log('Preserved new isolated async export desktop directory:', root)
  } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {}); await app.close().catch(() => {}) }
})
