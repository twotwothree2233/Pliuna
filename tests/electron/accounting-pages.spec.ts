import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const executablePath: string = createRequire(import.meta.url)('electron')

test('paged accounting replaces pages, preserves snapshots and survives isolated restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-accounting-desktop-'))
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory } })
  let app = await launch(), page = await app.firstWindow()
  const call = async (request: any): Promise<any> => { const response = await page.evaluate(r => window.pliuna.request(r), request); if (!response.ok) throw Error(response.error.code); return response.data }
  try {
    await expect(page.getByRole('heading', { name: '尚无任务', exact: true })).toBeVisible()
    const task = (await call({ type: 'task.create', title: 'Paged ledger synthetic' })).task.id
    await app.evaluate(async (_electron, { directory, task }) => {
      const Database = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('better-sqlite3'), db = new Database(directory + '/pliuna.sqlite')
      try { db.transaction(() => {
        db.prepare("INSERT INTO runs (id,task_id,state,commit_valid,runtime_epoch,limits_json,budget_json,created_at,ended_at) VALUES ('paged-run',?,'completed',0,'synthetic','{}','{}',?,?)").run(task, '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z')
        const insert = db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?)'); let sequence = 1
        for (let n = 0; n < 75; n++) for (const phase of ['reserved', 'dispatched', 'completed']) {
          const event = { version: 2, output_policy: 'service-default', request_id: 'request-' + n, run_id: 'paged-run', model_id: 'synthetic', model_revision: 1, purpose: 'main', phase, at: '2026-10-30T00:00:00.000Z', input_bytes: 2, estimated_input_tokens: 258, output_reserve: null, context_tokens: 1000000, components: { rules: 0, tools: 0, history: 0, summary: 0, current: 0, tool_results: 0, envelope: 2 }, usage: phase === 'completed' && n !== 74 ? { prompt_tokens: n, completion_tokens: 2 } : null, error: null }
          insert.run('accounting-' + sequence, task, sequence++, 'model.request.accounting', JSON.stringify(event), event.at)
        }
        db.prepare('UPDATE tasks SET next_sequence=?,revision=revision+1 WHERE id=?').run(sequence, task)
      })() } finally { db.close() }
    }, { directory, task })
    await test.step('open seeded task', async () => { await page.reload(); await page.getByRole('button', { name: /Paged ledger synthetic/ }).click() })
    const usage = page.getByRole('region', { name: '单次请求用量' }).first()
    await test.step('load first ledger page', async () => { await usage.getByRole('button', { name: '查询单次请求用量', exact: true }).click() })
    await expect(usage.locator('details')).toHaveCount(20); await expect(usage).toContainText('不是整个 Run 的合计')
    for (let n = 0; n < 3; n++) await test.step('load ledger page ' + (n + 2), async () => { await usage.getByRole('button', { name: '下一页请求用量', exact: true }).click() })
    await expect(usage.locator('details')).toHaveCount(15); await expect(usage).toContainText('请求 75'); await expect(usage).toContainText('另有 1 个请求 usage 未知')
    await usage.locator('details').last().locator('summary').click(); await usage.getByRole('button', { name: '查看此请求原用量事件', exact: true }).last().click(); await expect(usage.getByLabel('原用量事件')).toContainText('request-74')
    const first = await call({ type: 'host.run.accounting', task_id: task, run_id: 'paged-run' })
    await app.close(); app = await launch(); page = await app.firstWindow(); await page.waitForFunction(() => !!window.pliuna)
    const restored = await call({ type: 'host.run.accounting', task_id: task, run_id: 'paged-run' }); expect(restored.requests).toEqual(first.requests)
    await expect(call({ type: 'host.run.accounting', task_id: task, run_id: 'paged-run', cursor: first.next_cursor })).rejects.toThrow('INVALID_CURSOR')
    expect((await call({ type: 'task.snapshot', task_id: task })).record_total).toBe(225)
  } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {}); await app.close().catch(() => {}) }
})
